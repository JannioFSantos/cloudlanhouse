import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ApiError } from './errors.js';

/**
 * Micro-framework HTTP em cima de node:http.
 *
 * A API imita o mínimo do Express que o projeto usa (use/get/post/delete,
 * req.params/query/body, res.json/status/send/sendFile/cookie). Zero
 * dependências: `npm install` não é necessário para rodar.
 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function patternToRegex(pattern) {
  const keys = [];
  const source = pattern
    .replace(/\/+$/, '')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\?:([A-Za-z0-9_]+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
  return { regex: new RegExp(`^${source || '/'}$`), keys };
}

function enhance(res) {
  if (res._enhanced) return res;
  res._enhanced = true;

  res.status = (code) => {
    res.statusCode = code;
    return res;
  };

  res.json = (payload) => {
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
    return res;
  };

  res.send = (body) => {
    if (!res.headersSent) res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(body);
    return res;
  };

  res.sendFile = (file) => {
    fs.stat(file, (err, stat) => {
      if (err) {
        res.statusCode = 404;
        res.end('Arquivo não encontrado.');
        return;
      }
      if (!res.headersSent) {
        res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Cache-Control', 'no-cache');
      }
      fs.createReadStream(file).pipe(res);
    });
    return res;
  };

  res.cookie = (name, value, options = {}) => {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    if (options.maxAge != null) parts.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
    if (options.path) parts.push(`Path=${options.path}`);
    if (options.httpOnly) parts.push('HttpOnly');
    if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
    if (options.secure) parts.push('Secure');

    const existing = res.getHeader('Set-Cookie');
    const list = Array.isArray(existing) ? existing : existing ? [existing] : [];
    list.push(parts.join('; '));
    res.setHeader('Set-Cookie', list);
    return res;
  };

  res.clearCookie = (name, options = {}) => {
    const parts = [`${name}=`, 'Max-Age=0'];
    if (options.path) parts.push(`Path=${options.path}`);
    const existing = res.getHeader('Set-Cookie');
    const list = Array.isArray(existing) ? existing : existing ? [existing] : [];
    list.push(parts.join('; '));
    res.setHeader('Set-Cookie', list);
    return res;
  };

  return res;
}

export function createApp({ trustProxy = false } = {}) {
  const layers = [];

  function add(method, pattern, handler) {
    const { regex, keys } = patternToRegex(pattern);
    layers.push({ kind: 'route', method, regex, keys, handler });
    return app;
  }

  function app(req, res) {
    handle(req, res);
  }

  app.use = (fn) => {
    layers.push({ kind: 'mw', fn });
    return app;
  };
  app.get = (pattern, handler) => add('GET', pattern, handler);
  app.post = (pattern, handler) => add('POST', pattern, handler);
  app.delete = (pattern, handler) => add('DELETE', pattern, handler);

  function handle(req, res) {
    enhance(res);

    let parsed;
    try {
      parsed = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      res.statusCode = 400;
      res.end('Requisição inválida.');
      return;
    }

    req.path = decodeURIComponent(parsed.pathname);
    req.query = {};
    for (const [key, value] of parsed.searchParams) req.query[key] = value;
    req.params = {};

    const remote = req.socket.remoteAddress ?? '';
    const forwarded = trustProxy ? req.headers['x-forwarded-for'] : null;
    req.ip = forwarded ? String(forwarded).split(',')[0].trim() : remote;

    res.on('close', () => {
      if (!res.writableEnded) res.emit('aborted-by-client');
    });

    dispatch(req, res, 0, null);
  }

  function dispatch(req, res, index, err) {
    if (res.writableEnded) return;

    if (index >= layers.length) {
      if (err) return fail(req, res, err);
      res.statusCode = 404;
      res.end(req.path.startsWith('/api/') ? '{"error":{"code":"not_found","message":"Rota não encontrada."}}' : 'Não encontrado.');
      return;
    }

    const layer = layers[index];

    if (layer.kind === 'mw') {
      const isErrorHandler = layer.fn.length >= 4;
      if (err) {
        if (!isErrorHandler) return dispatch(req, res, index + 1, err);
        try {
          const result = layer.fn(err, req, res, (nextErr) => dispatch(req, res, index + 1, nextErr ?? null));
          if (result?.catch) result.catch((thrown) => dispatch(req, res, index + 1, thrown));
        } catch (thrown) {
          dispatch(req, res, index + 1, thrown);
        }
        return;
      }
      if (isErrorHandler) return dispatch(req, res, index + 1, null);

      try {
        const result = layer.fn(req, res, (nextErr) => dispatch(req, res, index + 1, nextErr ?? null));
        if (result?.catch) result.catch((thrown) => dispatch(req, res, index + 1, thrown));
      } catch (thrown) {
        dispatch(req, res, index + 1, thrown);
      }
      return;
    }

    if (err) return dispatch(req, res, index + 1, err);
    if (layer.method !== req.method && !(layer.method === 'GET' && req.method === 'HEAD')) {
      return dispatch(req, res, index + 1, null);
    }

    const match = layer.regex.exec(req.path.replace(/\/+$/, '') || '/');
    if (!match) return dispatch(req, res, index + 1, null);

    req.params = {};
    layer.keys.forEach((key, i) => {
      req.params[key] = decodeURIComponent(match[i + 1] ?? '');
    });

    try {
      const result = layer.handler(req, res, (nextErr) => dispatch(req, res, index + 1, nextErr ?? null));
      if (result?.catch) result.catch((thrown) => dispatch(req, res, index + 1, thrown));
    } catch (thrown) {
      dispatch(req, res, index + 1, thrown);
    }
  }

  function fail(req, res, err) {
    if (err instanceof ApiError) {
      res.statusCode = err.status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: { code: err.code, message: err.message, ...err.extra } }));
      return;
    }
    if (err?.type === 'entity.parse.failed') {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: { code: 'invalid_json', message: 'JSON inválido.' } }));
      return;
    }
    console.error('[http]', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: { code: 'internal', message: 'Erro interno.' } }));
  }

  return app;
}

export function jsonBody({ limit = 64 * 1024 } = {}) {
  return function bodyParser(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const contentType = String(req.headers['content-type'] ?? '');
    if (!contentType.includes('application/json')) {
      req.body = {};
      return next();
    }

    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error('Corpo grande demais.');
        error.type = 'entity.too.large';
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        req.body = {};
        return next();
      }
      try {
        const parsed = JSON.parse(raw);
        req.body = parsed && typeof parsed === 'object' ? parsed : {};
        next();
      } catch {
        const error = new Error('JSON inválido.');
        error.type = 'entity.parse.failed';
        next(error);
      }
    });

    req.on('error', next);
    return undefined;
  };
}

export function staticFiles(root) {
  const base = path.resolve(root);

  return function serveStatic(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    let relative = decodeURIComponent(req.path).replace(/^\/+/, '');
    if (!relative || relative.includes('..') || relative.includes('\0')) return next();

    let file = path.join(base, relative);

    const statOf = (candidate) => {
      try {
        const stat = fs.statSync(candidate);
        return stat.isFile() ? stat : null;
      } catch {
        return null;
      }
    };

    let stat = statOf(file);

    if (!stat && !path.extname(file)) {
      const withHtml = `${file}.html`;
      const htmlStat = statOf(withHtml);
      if (htmlStat) {
        file = withHtml;
        stat = htmlStat;
      }
    }

    if (!stat) return next();

    if (!res.headersSent) {
      res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Cache-Control', 'no-cache');
    }

    if (req.method === 'HEAD') {
      res.end();
      return undefined;
    }

    const stream = fs.createReadStream(file);
    stream.on('error', () => {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
    stream.pipe(res);
    return undefined;
  };
}

export { http };
