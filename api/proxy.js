const https = require('https');

function followRedirects(targetUrl, options, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));

    const parsedUrl = new URL(targetUrl);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    const req = https.request(reqOptions, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, targetUrl).toString();
        res.resume();
        return followRedirects(redirectUrl, { method: 'GET', headers: {} }, maxRedirects - 1)
          .then(resolve)
          .catch(reject);
      }
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });

    if (options.body) req.write(options.body);
    req.end();
  });
}

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    if (req.method === 'GET') {
      const gasUrl = req.query.url;
      if (!gasUrl) {
        return res.status(400).json({ error: 'Missing url parameter' });
      }
      const result = await followRedirects(gasUrl, { method: 'GET' });
      res.setHeader('Content-Type', result.headers['content-type'] || 'application/json');
      return res.status(result.statusCode).send(result.body);
    }

    if (req.method === 'POST') {
      const payload = req.body;
      const gasUrl = payload._gasUrl;
      if (!gasUrl) {
        return res.status(400).json({ error: 'Missing _gasUrl in body' });
      }
      delete payload._gasUrl;
      const postBody = JSON.stringify(payload);
      const result = await followRedirects(gasUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': Buffer.byteLength(postBody),
        },
        body: postBody,
      });
      res.setHeader('Content-Type', result.headers['content-type'] || 'application/json');
      return res.status(result.statusCode).send(result.body);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
};
