const http = require('http');
const handler = require('./api/diarize.js');

const server = http.createServer((req, res) => {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(obj));
  };
  handler(req, res);
});

const PORT = 8792;
server.listen(PORT, () => console.log(`local-server listening on :${PORT}`));
