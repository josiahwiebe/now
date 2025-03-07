import {
  NowRequest,
  NowResponse,
  NowRequestCookies,
  NowRequestQuery,
  NowRequestBody,
} from './types';
import { Server } from 'http';
import { Bridge } from './bridge';

function getBodyParser(req: NowRequest, body: Buffer) {
  return function parseBody(): NowRequestBody {
    if (!req.headers['content-type']) {
      return undefined;
    }

    const { parse: parseContentType } = require('content-type');
    const { type } = parseContentType(req.headers['content-type']);

    if (type === 'application/json') {
      try {
        return JSON.parse(body.toString());
      } catch (error) {
        throw new ApiError(400, 'Invalid JSON');
      }
    }

    if (type === 'application/octet-stream') {
      return body;
    }

    if (type === 'application/x-www-form-urlencoded') {
      const { parse: parseQuerystring } = require('querystring');
      // note: querystring.parse does not produce an iterable object
      // https://nodejs.org/api/querystring.html#querystring_querystring_parse_str_sep_eq_options
      const tempObj = parseQuerystring(body.toString());
      return parseQS(tempObj);
    }

    if (type === 'text/plain') {
      return body.toString();
    }

    return undefined;
  };
}

function getQueryParser({ url = '/' }: NowRequest) {
  return function parseQuery(): NowRequestQuery {
    const { URL } = require('url');
    // we provide a placeholder base url because we only want searchParams
    const params = new URL(url, 'https://n').searchParams;

    const query: { [key: string]: string | string[] } = {};
    for (const [key, value] of params) {
      query[key] = value;
    }

    return query;
  };
}

function getCookieParser(req: NowRequest) {
  return function parseCookie(): NowRequestCookies {
    const header: undefined | string | string[] = req.headers.cookie;

    if (!header) {
      return {};
    }

    const { parse } = require('cookie');
    return parse(Array.isArray(header) ? header.join(';') : header);
  };
}

function parseQSArray(key: string, value: any, acc: any): void {
  const bktNotation = /\[[^[\]\d]?]/.test(key);
  const result = /\[(\d*)\]$/.exec(key);
  key = key.replace(/\[\d*\]$/, '');

  if (!result) {
    acc[key] = value;
    return;
  }

  if (acc[key] === undefined) {
    if (bktNotation === true) {
      acc[key] = value;
      return;
    } else {
      acc[key] = [value];
    }
  }

  if (bktNotation === true) {
    acc[key] = [].concat(acc[key], value);
  } else {
    acc[key][result[1]] = value;
  }
}

function parseQS(input: { [key: string]: string }) {
  const parsed = Object.create(null);

  for (const [param, value] of Object.entries(input)) {
    parseQSArray(param, value, parsed);
  }

  for (const [key, value] of Object.entries(parsed)) {
    parsed[key] = value;
  }

  return parsed;
}

function status(res: NowResponse, statusCode: number): NowResponse {
  res.statusCode = statusCode;
  return res;
}

function setCharset(type: string, charset: string) {
  const { parse, format } = require('content-type');
  const parsed = parse(type);
  parsed.parameters.charset = charset;
  return format(parsed);
}

function createETag(body: any, encoding: 'utf8' | undefined) {
  const etag = require('etag');
  const buf = !Buffer.isBuffer(body) ? Buffer.from(body, encoding) : body;
  return etag(buf, { weak: true });
}

function send(req: NowRequest, res: NowResponse, body: any): NowResponse {
  let chunk: unknown = body;
  let encoding: 'utf8' | undefined;

  switch (typeof chunk) {
    // string defaulting to html
    case 'string':
      if (!res.getHeader('content-type')) {
        res.setHeader('content-type', 'text/html');
      }
      break;
    case 'boolean':
    case 'number':
    case 'object':
      if (chunk === null) {
        chunk = '';
      } else if (Buffer.isBuffer(chunk)) {
        if (!res.getHeader('content-type')) {
          res.setHeader('content-type', 'application/octet-stream');
        }
      } else {
        return json(req, res, chunk);
      }
      break;
  }

  // write strings in utf-8
  if (typeof chunk === 'string') {
    encoding = 'utf8';

    // reflect this in content-type
    const type = res.getHeader('content-type');
    if (typeof type === 'string') {
      res.setHeader('content-type', setCharset(type, 'utf-8'));
    }
  }

  // populate Content-Length
  let len: number | undefined;
  if (chunk !== undefined) {
    if (Buffer.isBuffer(chunk)) {
      // get length of Buffer
      len = chunk.length;
    } else if (typeof chunk === 'string') {
      if (chunk.length < 1000) {
        // just calculate length small chunk
        len = Buffer.byteLength(chunk, encoding);
      } else {
        // convert chunk to Buffer and calculate
        const buf = Buffer.from(chunk, encoding);
        len = buf.length;
        chunk = buf;
        encoding = undefined;
      }
    } else {
      throw new Error(
        '`body` is not a valid string, object, boolean, number, Stream, or Buffer'
      );
    }

    if (len !== undefined) {
      res.setHeader('content-length', len);
    }
  }

  // populate ETag
  let etag: string | undefined;
  if (
    !res.getHeader('etag') &&
    len !== undefined &&
    (etag = createETag(chunk, encoding))
  ) {
    res.setHeader('etag', etag);
  }

  // strip irrelevant headers
  if (204 === res.statusCode || 304 === res.statusCode) {
    res.removeHeader('Content-Type');
    res.removeHeader('Content-Length');
    res.removeHeader('Transfer-Encoding');
    chunk = '';
  }

  if (req.method === 'HEAD') {
    // skip body for HEAD
    res.end();
  } else if (encoding) {
    // respond with encoding
    res.end(chunk, encoding);
  } else {
    // respond without encoding
    res.end(chunk);
  }

  return res;
}

function json(req: NowRequest, res: NowResponse, jsonBody: any): NowResponse {
  const body = JSON.stringify(jsonBody);

  // content-type
  if (!res.getHeader('content-type')) {
    res.setHeader('content-type', 'application/json; charset=utf-8');
  }

  return send(req, res, body);
}

export class ApiError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function sendError(
  res: NowResponse,
  statusCode: number,
  message: string
) {
  res.statusCode = statusCode;
  res.statusMessage = message;
  res.end();
}

function setLazyProp<T>(req: NowRequest, prop: string, getter: () => T) {
  const opts = { configurable: true, enumerable: true };
  const optsReset = { ...opts, writable: true };

  Object.defineProperty(req, prop, {
    ...opts,
    get: () => {
      const value = getter();
      // we set the property on the object to avoid recalculating it
      Object.defineProperty(req, prop, { ...optsReset, value });
      return value;
    },
    set: value => {
      Object.defineProperty(req, prop, { ...optsReset, value });
    },
  });
}

export function createServerWithHelpers(
  listener: (req: NowRequest, res: NowResponse) => void | Promise<void>,
  bridge: Bridge
) {
  const server = new Server(async (_req, _res) => {
    const req = _req as NowRequest;
    const res = _res as NowResponse;

    try {
      const reqId = req.headers['x-now-bridge-request-id'];

      // don't expose this header to the client
      delete req.headers['x-now-bridge-request-id'];

      if (typeof reqId !== 'string') {
        throw new ApiError(500, 'Internal Server Error');
      }

      const event = bridge.consumeEvent(reqId);

      setLazyProp<NowRequestCookies>(req, 'cookies', getCookieParser(req));
      setLazyProp<NowRequestQuery>(req, 'query', getQueryParser(req));
      setLazyProp<NowRequestBody>(req, 'body', getBodyParser(req, event.body));

      res.status = statusCode => status(res, statusCode);
      res.send = body => send(req, res, body);
      res.json = jsonBody => json(req, res, jsonBody);

      await listener(req, res);
    } catch (err) {
      if (err instanceof ApiError) {
        sendError(res, err.statusCode, err.message);
      } else {
        throw err;
      }
    }
  });

  return server;
}
