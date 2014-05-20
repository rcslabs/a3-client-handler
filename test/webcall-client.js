var cluster = require('cluster');

var opts = {};

var argv = require('optimist')
    .usage('Usage: node ./webcall-client.js --url=http://127.0.0.1:8000 --service=click2call --username=1010 --password=1234 [--dial-number=1007] [--hangup-timeout=0] [--reject-call=BUSY] [--log-level=0-4]')
    .demand(['url'])
    .argv;

opts['url'] = argv['url'];
opts['service'] = (typeof argv['service'] !== 'undefined' ? argv['service'] : 'click2call');
opts['log-level'] = (typeof argv['log-level'] !== 'undefined' ? parseInt(argv['log-level']) : 0); 

if(cluster.isMaster){
    opts['username'] = argv['username'];
    opts['password']  = argv['password'];
    opts['dial-number'] = (typeof argv['dial-number'] !== 'undefined' ? argv['dial-number'] : null); 
    opts['hangup-timeout'] = (typeof argv['hangup-timeout'] !== 'undefined' ? parseInt(argv['hangup-timeout']) : 0);
    opts['reject-call'] = (typeof argv['reject-call'] !== 'undefined' ? argv['reject-call'] : null); 
}else{
    // get another from env
    var _env = cluster.worker.process.env;
    if(typeof _env['_username'] === 'undefined'){
        console.error("Username is absent");
        exit(1);
    }
    if(typeof _env['password'] === 'undefined'){
        console.error("Password is absent");
        exit(1);
    }
    opts['username'] = _env['_username']; // do not intersect with system env 'username'
    opts['password'] = _env['password'];
    opts['dial-number'] = (typeof _env['dial-number'] !== 'undefined' ? _env['dial-number'] : null); 
    opts['hangup-timeout'] = (typeof _env['hangup-timeout'] !== 'undefined' ? parseInt(_env['hangup-timeout']) : 0);
    opts['reject-call'] = (typeof _env['reject-call'] !== 'undefined' ? _env['reject-call'] : null); 
}

if(opts['log-level'] > 1){
    console.log(opts);
}

//var redis = require("redis").createClient(6379, opts['url'].replace('http://', ''));

var io = require('socket.io-client');
var socket = io.connect(opts.url);

socket.on('connect', onConnected);
socket.on('error', function(e){console.error(e);});
socket.on('disconnect', function(){});
socket.on('message', onMessage);

var State = {
    INIT            : 'INIT',
    SESSION_STARTING: 'SESSION_STARTING',
    SESSION_STARTED : 'SESSION_STARTED',
    SESSION_FAILED  : 'SESSION_FAILED',
    CALL_STARTING   : 'CALL_STARTING',
    CALL_STARTED    : 'CALL_STARTED',
    CALL_FAILED     : 'CALL_FAILED',
    CALL_FINISHED   : 'CALL_FINISHED'
};

var state = State.INIT;
var sessionId;
var cc4voice = {profile: "RTP/SAVPF", ice: true, rtcpMux: true, bundle: false, userAgent: "Chrome", audio: ["PCMA/8000"], ssrcRequired: true};
var cc4video = {profile: "RTP/SAVPF", ice: true, rtcpMux: true, bundle: false, userAgent: "Chrome", audio: ["PCMA/8000"], ssrcRequired: true, video: ["VP8/90000"]};

function prepareMessageForConsole(message, skip){
    var m = JSON.stringify(message);
    if(skip){
        m = JSON.parse(m);
        if(typeof m['sdp'] !== 'undefined'){ m['sdp'] = '...skipped...'; }
        if(typeof m['cc']  !== 'undefined'){ m['cc']  = '...skipped...'; }
        m = JSON.stringify(m);
    }
    return m;
}

function send(msg){
    msg.service = opts['service'];

    // added 'typz' feature - quick fix
    switch (msg.type){
        case 'START_SESSION':
        case 'CLOSE_SESSION':
            msg["typz"] = 'AuthMessage';
            break;

        case 'START_CALL':
        case 'REJECT_CALL':
        case 'ACCEPT_CALL':
        case 'HANGUP_CALL':
        case 'SEND_DTMF':
            msg["typz"] = 'CallMessage';
            break;

        case 'SDP_OFFER':
        case 'SDP_ANSWER':
            msg["typz"] = 'MediaMessage';
            break;

        case 'JOIN_CHATROOM':
        case 'UNJOIN_CHATROOM':
        case 'CHAT_MESSAGE':
            msg["typz"] = 'ChatMessage';
            break;
    }

    if(typeof sessionId != 'undefined'){ 
        msg.sessionId = sessionId; 
    }
    
    if(0 == msg.service.indexOf('constructor')){
        var tkns = msg.service.split(':');
        msg.service = tkns[0];
        msg.projectId = tkns[1];
    }

    if(opts['log-level'] > 2){
        console.log('Send', prepareMessageForConsole(msg, (opts['log-level'] < 4)));
    }
    
    socket.emit('message', msg);  
}

function onConnected(){
    setState(State.SESSION_STARTING);
    send({"type": "START_SESSION", "username": ""+opts['username'], "password": ""+opts['password']});  
}

function onMessage(message)
{
    if(opts['log-level'] > 2){
        console.log('Recv', prepareMessageForConsole(message, (opts['log-level'] < 4))); 
    }

    switch(state){
        case State.SESSION_STARTING:
            if(message.type == 'SESSION_STARTED'){
                sessionId = message.sessionId;
                setState(State.SESSION_STARTED);
                if(null != opts['dial-number']){
                    startCall(opts['dial-number']);
                } 
            }else if(message.type == 'SESSION_FAILED'){
                setState(State.SESSION_FAILED); 
                exit(0);  
            }
            break;

        case State.SESSION_STARTED:
            if(message.type == 'INCOMING_CALL'){
                setState(State.CALL_STARTING); 
                onIncomingCall(message);
            }
            break;

        case State.CALL_STARTING:
            if(message.type == 'SDP_OFFER'){
                onSdpOffer(message);    
            }else if(message.type == 'CALL_STARTED'){
                onCallStarted(message);   
            }else if(message.type == 'CALL_FAILED'){
                onCallFailed(message);
            }
            break;

        case State.CALL_STARTED:
            if(message.type == 'CALL_FINISHED'){
                onCallFinished(message);
            }else if(message.type == 'CALL_FAILED'){
                onCallFailed(message);
            }
            break;   
    }
}

function setState(newState){
    if(opts['log-level'] > 0)
    {
        var msg = state+'->'+newState;
        if(newState == State.SESSION_STARTING){
            msg += ' ('+ opts['username']+':'+opts['password']+')';
        }else if(newState == State.CALL_STARTING){
            msg += ' ('+ opts['dial-number']+')';
        }
        console.log(msg);
    }

    state = newState;

    // write data to redis
    if(cluster.isWorker){
        var key = "client:"+cluster.worker.process.pid+":"+newState;
        //redis.SET(key, (new Date).getTime());
    }
}

function startCall(destination){
    setState(State.CALL_STARTING);
    send({"type": "START_CALL", "bUri": ""+destination, "cc": cc4video, "vv": [true, true]});
}

function onCallStarted(message){
    setState(State.CALL_STARTED); 
    if(0 < opts['hangup-timeout']){
        setTimeout(function(){
            send({"type": "HANGUP_CALL", "callId": message.callId});
        }, opts['hangup-timeout']);
    }
}

function onCallFinished(message){
    setState(State.CALL_FINISHED);
    exit(0);
}

function onCallFailed(message){
    setState(State.CALL_FAILED);
    exit(0);
}

function onIncomingCall(message){
    if(opts['reject-call'] != null){
        send({"type": "REJECT_CALL", "callId": message.callId, "reason": opts['reject-call']});
    }else{
        send({"type": "ACCEPT_CALL", "callId": message.callId, "cc": (message.vv[1] ? cc4video : cc4voice)});        
    }
}

function onIncomingCanceled(message){}

function onSdpOffer(message){
    var sdpAnswer = "";
    sdpAnswer += "v=0\r\n";
    sdpAnswer += "o=- 4603121677220489070 3 IN IP4 127.0.0.1\r\n";
    sdpAnswer += "s=-\r\n";
    sdpAnswer += "t=0 0\r\n";
    sdpAnswer += "a=msid-semantic: WMS TyXX5HP11lxxmzzn218IWqGK0vp3Z6IqsBLL\r\n";
    sdpAnswer += "m=audio 1 RTP/SAVPF 8 101\r\n";
    sdpAnswer += "c=IN IP4 0.0.0.0\r\n";
    sdpAnswer += "a=rtcp:1 IN IP4 0.0.0.0\r\n";
    sdpAnswer += "a=ice-ufrag:OrJlZkFMAiuPN5RR\r\n";
    sdpAnswer += "a=ice-pwd:TANNKhqMuZ7zV7I/n5xVM5h5\r\n";
    sdpAnswer += "a=mid:audio\r\n";
    sdpAnswer += "a=sendrecv\r\n";
    sdpAnswer += "a=rtcp-mux\r\n";
    sdpAnswer += "a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:ULID8b0P7Gse98rHRZwbYRqOne3pXoLORZGzjtGp\r\n";
    sdpAnswer += "a=rtpmap:8 PCMA/8000\r\n";
    sdpAnswer += "a=rtpmap:101 telephone-event/8000\r\n";
    sdpAnswer += "a=ssrc:1945289674 cname:bihidMCd5+ASWTPG\r\n";
    sdpAnswer += "a=ssrc:1945289674 msid:TyXX5HP11lxxmzzn218IWqGK0vp3Z6IqsBLL TyXX5HP11lxxmzzn218IWqGK0vp3Z6IqsBLLa0\r\n";
    sdpAnswer += "a=ssrc:1945289674 mslabel:TyXX5HP11lxxmzzn218IWqGK0vp3Z6IqsBLL\r\n";
    sdpAnswer += "a=ssrc:1945289674 label:TyXX5HP11lxxmzzn218IWqGK0vp3Z6IqsBLLa0\r\n";
    sdpAnswer += "m=video 1 RTP/SAVPF 96\r\n";
    sdpAnswer += "c=IN IP4 0.0.0.0\r\n";
    sdpAnswer += "a=rtcp:1 IN IP4 0.0.0.0\r\n";
    sdpAnswer += "a=ice-ufrag:LsGKThqnufALMbuI\r\n";
    sdpAnswer += "a=ice-pwd:q8NwKAQANAKXI7IuZSDLjy/7\r\n";
    sdpAnswer += "a=mid:video\r\n";
    sdpAnswer += "a=sendrecv\r\n";
    sdpAnswer += "a=rtcp-mux\r\n";
    sdpAnswer += "a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:rVPrByt2PXL8MVooYCwzZrM1ld5RSjKO12S+uRRP\r\n";
    sdpAnswer += "a=rtpmap:96 VP8/90000\r\n";
    sdpAnswer += "a=ssrc:2695872529 cname:bihidMCd5+ASWTPG\r\n";
    sdpAnswer += "a=ssrc:2695872529 msid:TyXX5HP11lxxmzzn218IWqGK0vp3Z6IqsBLL TyXX5HP11lxxmzzn218IWqGK0vp3Z6IqsBLLv0\r\n";
    sdpAnswer += "a=ssrc:2695872529 mslabel:TyXX5HP11lxxmzzn218IWqGK0vp3Z6IqsBLL\r\n";
    sdpAnswer += "a=ssrc:2695872529 label:TyXX5HP11lxxmzzn218IWqGK0vp3Z6IqsBLLv0\r\n";
        
    message.type = "SDP_ANSWER";
    message.sdp = sdpAnswer;
    send(message);
}

function exit(code){ 
    socket.disconnect();
    if(cluster.isWorker){
        cluster.worker.process.exit(code);    
    }else if(cluster.isMaster){
        process.exit(code);
    }
}