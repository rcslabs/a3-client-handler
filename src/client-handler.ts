/// <reference path="./node.d.ts" />
/// <reference path="./redis.d.ts" />

/**
 * Ypu should use tsc typescript compiler >0.9
 * Compile: tsc -d --sourcemap client-handler.ts --target ES5 --outDir <OUT_DIR> --out client-handler.js
 * Usage: node ./client-handler.js [--log-level=0-3] [--config=<filename>] [--host=<hostname>] [--port=<port>] [--messaging-uri=redis://192.168.1.38:6379]
 */


var fs = require('fs');
var sio = require('socket.io');
var http = require('http');
var argv = require('optimist').argv;
var redis = require('redis');
var moment = require('moment');
var cluster = require('cluster');
var express = require('express');
var RedisStore = require('socket.io/lib/stores/redis');


class Utils
{
    static logDate(): string{
        return '['+moment(new Date()).format('YYYY-MM-DD HH:mm:ss')+']';
    }

    static logSanitize(value: string): string{
        if(typeof value !== 'string'){ value = JSON.stringify(value); }
        return value.replace(/(\r\n|\n|\r)/gm, "");
    }
}

class BaseConfig
{
    defaults: any;
    args: any;
    fromFile: any;

    constructor()
    {
        this.defaults = {};
        this.args = {};
        this.fromFile = {};
    }  

    init(args?):void
    {
        if(typeof args !== 'undefined'){
            if(typeof args.config !== 'undefined'){
                this.initFromFile(args.config);
                delete args.config;
            }
            for(var p in args){
                var k = this.dashSeparatedToCamelCase(p);
                this.args[k] = args[p];
            }             
        }
    } 

    initFromFile(path: string):void
    {
        try{
            var data = fs.readFileSync(path, 'utf8');
            var o = this.parseFileData(data);
            for(var p in o){
                var k = this.dashSeparatedToCamelCase(p);
                this.fromFile[k] = o[p];
            }            
        }catch(e){
            console.error("Unable to read file '"+path+"'");
        }
    }

    parseFileData(data: string):any
    {
        var regex = {
            section: /^\s*\[\s*([^\]]*)\s*\]\s*$/,
            param: /^\s*([\w\.\-\_]+)\s*=\s*(.*?)\s*$/,
            comment: /^\s*;.*$/
        };

        var value = {};
        var lines = data.split(/\r\n|\r|\n/);
        var section = null;
        lines.forEach(function(line){
            if(regex.comment.test(line)){
                return;
            }else if(regex.param.test(line)){
                var match = line.match(regex.param);
                if(section){
                    value[section][match[1]] = match[2];
                }else{
                    value[match[1]] = match[2];
                }
            }else if(regex.section.test(line)){
                var match = line.match(regex.section);
                value[match[1]] = {};
                section = match[1];
            }else if(line.length == 0 && section){
                section = null;
            };
        });

        return value;
    }

    dashSeparatedToCamelCase(value: string): string
    {
        return value.replace(/-(.)/gi, function(str,...args){ return args[0].toUpperCase(); });
    }

    getPropertyAsString(name: string): string
    {
        if(typeof this.args[name] !== 'undefined'){
            return this.args[name];
        }else if(typeof this.fromFile[name] !== 'undefined'){
            return this.fromFile[name];
        }else if(typeof this.defaults[name] !== 'undefined'){
            return this.defaults[name];
        }else{
            throw "Property {"+name+"} not found in config.";
        } 
    }

    getPropertyAsNumber(name: string): number
    {
        return parseInt(this.getPropertyAsString(name));
    }

    getPropertyAsBoolean(name: string): boolean
    {
        return !!this.getPropertyAsString(name);
    }  
}

class SIOServerConfig extends BaseConfig
{

    constructor()
    {
        super();
        this.defaults.host = '0.0.0.0';
        this.defaults.port = 8000;
        this.defaults.messagingUri = 'redis://127.0.0.1:6379';
        this.defaults.mqHost = '127.0.0.1';
        this.defaults.mqPort = 6379;        
        this.defaults.logLevel = 0;
        this.defaults.pid = 0;
    }

    get pid(): string{ return this.defaults.pid; }
    set pid(value: string) { this.defaults.pid = value; }

    get host(): string{ return super.getPropertyAsString('host'); }
    get port(): number{ return super.getPropertyAsNumber('port'); }
    get messagingUri(): string{ return super.getPropertyAsString('messagingUri'); }
    get logLevel(): number{ return super.getPropertyAsNumber('logLevel'); }

    get mqHost(): string { return super.getPropertyAsString('mqHost'); }
    get mqPort(): number { return super.getPropertyAsNumber('mqPort'); }

    get selfChannel(): string { return "sio:"+this.host+":"+this.port+":"+this.pid; }

    init(args?):void
    {
        super.init(args);
        this.parseMqUri(this.args);
    }

    initFromFile(path: string):void
    {
        super.initFromFile(path);
        this.parseMqUri(this.fromFile);
    }

    parseMqUri(target:any){
        var a = /^([^:]+):\/\/([^:\/]+)(:(\d+))?$/.exec(target.messagingUri); 
        var o = {host:null, port:-1};
        if(null != a){ 
            target.mqHost = a[2]; 
            if(typeof a[4] !== 'undefined') target.mqPort = parseInt(a[4]); 
        } 
    }

    _toString():string{
        var s = "[SIOServerConfig";
        s += "  host=" + this.host;
        s += ", port=" + this.port;
        s += ", logLevel=" + this.logLevel;
        s += ", messagingUri=" + this.messagingUri;
        s += ", mqHost=" + this.mqHost;
        s += ", mqPort=" + this.mqPort;
        s += ", selfChannel=" + this.selfChannel;
        s += "]";
        return s;
    }
}

interface Message
{
    type: string;
}

interface MessageBrokerDelegate
{
    onMessageBrokerConnected(broker: MessageBroker): void;
    onMessageBrokerError(broker: MessageBroker, error: any): void;
    onMessageBrokerMessage(broker: MessageBroker, channel: string, message: any): void;
}

class MessageBroker
{
    host: string;
    port: number;
    pub: any;
    sub: any;
    delegate: MessageBrokerDelegate;
    connDate: Date;

    constructor(){}

    setDelegate(delegate: MessageBrokerDelegate){
        this.delegate = delegate;
    }

    connect(host: string, port: number){
        this.host = host;
        this.port = port;
        
        this.pub = redis.createClient(port, host);
        this.sub = redis.createClient(port, host);
        var self = this;
        this.pub.on('connect', function(){self.onConnected()});         
        this.pub.on('error',   function(){self.onConnectionError()});
        this.pub.on('end',     function(){self.onConnectionError()});  
        this.sub.on('connect', function(){self.onConnected()});         
        this.sub.on('error',   function(){self.onConnectionError()}); 
        this.sub.on('end',     function(){self.onConnectionError()});             
    }

    onConnected(){
        if(this.pub.connected && this.sub.connected){
            var self = this;
            this.pub.send_command('echo', ['ECHO'], function (err, reply) {
                self.connDate = new Date();
                if(self.delegate){ 
                    self.delegate.onMessageBrokerConnected(self);
                    self.sub.on("message", function(channel, message) {
                        self.delegate.onMessageBrokerMessage(self, channel, JSON.parse(message));
                    });                     
                }                
            });
        }
    }

    onConnectionError(){ 
        if(!(this.pub.connected && this.sub.connected)){
            var msg = 'Connection error to ' + this.host + ':' + this.port;
            this.sub.removeAllListeners("message");
            if(this.delegate){ 
                this.delegate.onMessageBrokerError(this, msg); 
            } 
        }
    }

    publish(channel: string, message: Message, cb?: Function){
        this.pub.publish(channel, JSON.stringify(message), cb);
    }

    subscribe(channel: string){
        this.sub.subscribe(channel);
    }

    unsubscribe(channel: string){
        this.sub.unsubscribe(channel);
    }
}

class SIOServer implements MessageBrokerDelegate
{
    config: SIOServerConfig;
    broker: MessageBroker;
    io: any;
    sessions: any;

    constructor(config: SIOServerConfig){
        this.io = null;
        this.config = config;
        this.broker = new MessageBroker();
        this.broker.setDelegate(this);
        this.sessions = {};
        this.config.pid = ""+process.pid;
    }

    log(level:string, data:string){
        // FIXME: non-ascii symbols in log crashed the main process process.send({type:'log', pid:process.pid, level:level, data:data}); 
        console[level](Utils.logDate(), process.pid, data);  
    }

    run(){ 
        var self = this;
        var app = express();     
        var server = http.createServer(app);
        server.listen(this.config.port, this.config.host);
        app.use(express.static(__dirname + '/../../static'));

        // init internal socket.io redis clients   
        var err = function(){ /* Silent error handler for RedisStore */ };
        var pub = redis.createClient(this.config.mqPort, this.config.mqHost); pub.on('error', err);
        var sub = redis.createClient(this.config.mqPort, this.config.mqHost); sub.on('error', err);
        var cmd = redis.createClient(this.config.mqPort, this.config.mqHost); cmd.on('error', err); 
        
        var sio_props = {
            store : new RedisStore({redis:redis, redisPub:pub, redisSub:sub, redisClient:cmd}),
            transports : ['websocket', 'flashsocket', 'htmlfile', 'xhr-polling', 'jsonp-polling'],
            'log level' : self.config.logLevel
        };

        this.io = sio.listen(server, sio_props);

        server.on('error', function(e){ 
            self.log('error', 'Error ' + e.code + ' on socket.io server');
            if('EADDRNOTAVAIL' == e.code){ process.exit(1); }
        });

        // if server starts ok - continue running app
        server.on('listening', function(e){
            self.io.set('log level', self.config.logLevel);
            self.log('log', 'socket.io server started');
            // start the message broker connection
            self.broker.connect(self.config.mqHost, self.config.mqPort);                
        });

        this.io.sockets.on('connection', function (socket) { 
            socket.on('message', function(msg) {
                try{ 
                    self.log('log', 'Recv from client ' + socket.id + ' ' + Utils.logSanitize(msg));                    
                    if(typeof msg.type === 'undefined'){ throw 'Type of message not specified'; }
                    
                    var _msg: any = new Object;
                    for(var p in msg){ _msg[p] = msg[p]; }
                    _msg.type = msg.type;
                    var sentTo = msg.service;
                    if("START_SESSION" == msg.type || "CLOSE_SESSION" == msg.type){
                        _msg.clientId = socket.id;
                        _msg.sender = self.config.selfChannel;   
                    }
                    self.broker.publish(sentTo, _msg);
                    self.log('log', 'Send ' + sentTo + ' ' + Utils.logSanitize(_msg));
                }catch(e){
                    self.log('error', 'Error on handle message from client ' + socket.id + ' ' + Utils.logSanitize(e)); 
                }
            });

            socket.on('disconnect', function() { 
                for(var sid in self.sessions){
                    if(self.sessions[sid].clientId == socket.id){
                        var msg = {
                            type: "CLOSE_SESSION", 
                            sessionId: sid, 
                            sender: self.config.selfChannel, 
                            service: self.sessions[sid].service
                        };
                        self.broker.publish(msg.service, msg); 
                        break; 
                    }
                }
            });
        });        
    }

    onMessageBrokerConnected(broker: MessageBroker): void{ 
        this.log('log', 'Message broker connected to ' + broker.host + ':' + broker.port);  
        broker.subscribe(this.config.selfChannel);       
    }

    onMessageBrokerError(broker: MessageBroker, error: any): void{ 
        this.log('error', error); 
    }
    
    onMessageBrokerMessage(broker: MessageBroker, channel: string, message: any): void
    { 
        this.log('log', 'Recv ' + channel + ' ' + Utils.logSanitize(message));   
    
        if(channel == this.config.selfChannel){
            if("SESSION_STARTED" == message.type){
                broker.subscribe('sid:'+message.sessionId);
                this.sessions[message.sessionId] = {
                    clientId : message.clientId, 
                    service :  message.service
                };
                var socket = this.io.sockets.sockets[message.clientId];
                if(socket) socket.emit('message', message);                
            }else if("SESSION_FAILED" == message.type || "SESSION_CLOSED" == message.type){
                broker.unsubscribe('sid:'+message.sessionId);
                var socket = this.io.sockets.sockets[message.clientId];
                if(socket) socket.emit('message', message);                
                delete this.sessions[message.sessionId];
            }else{
                this.log('warn', 'Unknown message type' + message.type + 'for channel' + channel);    
            }   
        }else if(0 == channel.indexOf('sid:')){
            var sid = channel.split(':')[1];  // channel name is 'sid:<session id>'
            var cid = this.sessions[sid].clientId;
            if(typeof cid === 'undefined'){
                this.log('error', 'SIO client id not found for session id='+sid);   
            }else{
                var socket = this.io.sockets.sockets[cid];
                if(socket) socket.emit('message', message);                
            }
        }else{
            this.log('error', 'Unknown channel' + channel);   
        }          
    } 
}

var config = new SIOServerConfig();
config.init(argv);

if(cluster.isMaster) {   

    console.log(config._toString());

    // FIXME: multiple processes
    //require('os').cpus().forEach(function() {
        cluster.fork();
    //});

    cluster.on('fork', function(worker) {
        worker.on('message', function(msg) {
            if('log' == msg.type){
                console[msg.level](Utils.logDate(), msg.pid, msg.data);
            }
        });
    });

    cluster.on('exit', function(worker, code, signal) {
        var exitCode = worker.process.exitCode;
        console.log(Utils.logDate(), 'worker ' + worker.process.pid + ' died ('+exitCode+'). restarting...');
        cluster.fork();
    });

}else{
    var s = new SIOServer(config);
    s.run();
}