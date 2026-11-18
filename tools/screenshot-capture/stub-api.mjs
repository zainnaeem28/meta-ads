import http from 'node:http';
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('access-control-allow-origin', '*');
    if (req.url?.startsWith('/api/v1/dev/token')) {
      const email = (() => { try { return JSON.parse(body).email } catch { return 'owner@example.test' } })();
      res.end(JSON.stringify({ success: true, data: { token: 'stub.token.value', sub: 'user_local_stub', email, expiresInSeconds: 3600 } }));
    } else if (req.url?.includes('/health')) res.end('{"status":"ok"}');
    else { res.statusCode = 503; res.end(JSON.stringify({ success: false, error: { code: 'UNAVAILABLE' } })); }
  });
}).listen(4100, '127.0.0.1');
