var cluster = require('cluster');

var benchmark = {
	url : 'http://192.168.1.200',
	service : 'click2call',
	logLevel : 1,
	registerInterval : 1000,
	hangupTimeout : 100000, 
	password: '1234',
	outgoingClients : {username:'1100-1149', dialNumber:'9196'},
	// incoming calls still not work
	incomingClients : {username:'1200-1299', rejectCall:'BUSY'}
}

cluster.setupMaster({
	exec : "webcall-client.js",
	args : [
		'--url='+benchmark.url,
		'--service='+benchmark.service,
		'--log-level='+benchmark.logLevel
	]//,silent : true
});

function prepareClients(source){
	var usernames = prepareValues(source.username);
	var dialNumbers = prepareValues(source.dialNumber); 
	var dst = [];
	while(usernames.length){
		var dn = dialNumbers.shift();
				 dialNumbers.push(dn); // dial numbers as ring array
		dst.push({
			'username' : usernames.shift(),
			'password' : benchmark.password,
			'dial-number' : dn,
			'hangup-timeout' : benchmark.hangupTimeout 
		});
	}
	return dst;
}

function prepareValues(source){
	if(source instanceof Array) return source;
	if(typeof source !== 'string') return [];
	var dst = [];
	if(-1 != source.indexOf('-')) {
		var tokens = source.split('-');
		var e1 = parseInt(tokens[0]);
		var e2 = parseInt(tokens[1]);
		for(var i=e1; i<=e2; ++i) {
			dst.push(""+i);
		}
		return dst;
	}else if(-1 != source.indexOf(',')){
		return source.split(',');	
	}else{
		dst.push(source);
	}
	return dst;
}

benchmark.outgoingClients = prepareClients(benchmark.outgoingClients);
benchmark.incomingClients = prepareClients(benchmark.incomingClients);

//console.log(benchmark);

var forkIntv = setInterval(function(){
	if(benchmark.outgoingClients.length){
		var c = benchmark.outgoingClients.shift();
		cluster.fork({
			'_username' : c['username'],
			'password'  : benchmark.password,
			'dial-number' : c['dial-number'],
			'hangup-timeout' : c['hangup-timeout']
		});
	}else{
		clearInterval(forkIntv);
	}
}, benchmark.registerInterval);

var cnt = 0;

cluster.on('fork', function(worker) { 
	console.log('Clients count', ++cnt); 
});

cluster.on('exit', function(worker, code, signal) {
	console.log('Clients count', --cnt); 
    var exitCode = worker.process.exitCode;
    console.log("Exit code:", exitCode);
    if(0 == cnt){ process.exit(0); }
});