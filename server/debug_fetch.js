const http = require('http');
const options = { hostname: 'localhost', port: 3000, path: '/api/tree/full', method: 'GET' };
const req = http.request(options, res => {
  console.log('status', res.statusCode);
  let data='';
  res.on('data', chunk => data+=chunk);
  res.on('end', ()=>{
    try{ const j = JSON.parse(data); console.log('json keys:', Object.keys(j)); console.log('nodes length:', Array.isArray(j.nodes)? j.nodes.length : 'no nodes'); }
    catch(e){ console.log('body text:', data); }
  });
});
req.on('error', e => console.error('error', e));
req.end();
