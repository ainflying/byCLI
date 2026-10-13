import { describe, expect, it } from 'vitest';
import { redactHeaders, redactText, redactUrl, redactValue } from './redaction.js';

describe('observation redaction', () => {
  it('redacts sensitive headers by default', () => {
    expect(redactHeaders({
      authorization: 'Bearer secret-token',
      cookie: 'sid=abc',
      'set-cookie': 'sid=abc',
      accept: 'application/json',
    })).toEqual({
      authorization: '[REDACTED]',
      cookie: '[REDACTED]',
      'set-cookie': '[REDACTED]',
      accept: 'application/json',
    });
  });

  it('redacts sensitive url query params', () => {
    expect(redactUrl('https://x.test/api?token=abc&ok=1&password=secret'))
      .toBe('https://x.test/api?token=[REDACTED]&ok=1&password=[REDACTED]');
  });

  it('preserves raw url redaction semantics for encoded and diagnostic punctuation in values', () => {
    expect(redactUrl("https://x.test/api?token=abc%26SECRET,tail;'quoted&ok=1"))
      .toBe('https://x.test/api?token=[REDACTED]&ok=1');
  });

  it('redacts fingerprint url query params while preserving unrelated params', () => {
    expect(redactUrl('https://mp.weixin.qq.com/cgi-bin/searchbiz?fingerprint=fp%2B%2F%3Dsecret&ok=1'))
      .toBe('https://mp.weixin.qq.com/cgi-bin/searchbiz?fingerprint=[REDACTED]&ok=1');
  });

  it('redacts password and token fields recursively', () => {
    expect(redactValue({
      user: 'alice',
      password: 'secret',
      nested: { access_token: 'abc123456789', value: 'safe' },
    })).toEqual({
      user: 'alice',
      password: '[REDACTED]',
      nested: { access_token: '[REDACTED]', value: 'safe' },
    });
  });

  it('retains broad token field-name redaction semantics', () => {
    expect(redactValue({
      idtoken: 'credential',
      tokenvalue: 'credential',
      tokenCount: 42,
      nested: { tokenCount: '42' },
    })).toEqual({
      idtoken: '[REDACTED]',
      tokenvalue: '[REDACTED]',
      tokenCount: '[REDACTED]',
      nested: { tokenCount: '[REDACTED]' },
    });
  });

  it('redacts fingerprint fields recursively', () => {
    expect(redactValue({ nested: { fingerprint: 'fp+/=secret' } })).toEqual({
      nested: { fingerprint: '[REDACTED]' },
    });
  });

  it('redacts exact and segmented fingerprint fields without matching unrelated substrings', () => {
    expect(redactValue({
      browserfingerprintlabel: 'visible',
      fingerprint: 'exact-secret',
      wechat_fingerprint: 'delimited-secret',
      wechatFingerprint: 'camel-secret',
    })).toEqual({
      browserfingerprintlabel: 'visible',
      fingerprint: '[REDACTED]',
      wechat_fingerprint: '[REDACTED]',
      wechatFingerprint: '[REDACTED]',
    });
  });

  it('redacts fingerprint and token assignments in diagnostic text', () => {
    expect(redactText('request failed: fingerprint=fp-secret&token=token-secret'))
      .toBe('request failed: fingerprint=[REDACTED]&token=[REDACTED]');
  });

  it('does not treat redaction marker prefixes as already-redacted values', () => {
    expect(redactText('token=[REDACTED]ACTUAL_SECRET'))
      .toBe('token=[REDACTED]');
    expect(redactText('password="[REDACTED]ACTUAL_SECRET"'))
      .toBe('password=[REDACTED]');
  });

  it('redacts encoded query assignments in nested observation event text', () => {
    expect(redactValue({
      stream: 'network',
      requestBody: 'payload%3Dvalue%26token%3D987654321%26lang%3Dzh_CN',
      escapedBody: 'payload= value\\u0026token=123456789\\u0026lang=zh_CN',
    })).toEqual({
      stream: 'network',
      requestBody: 'payload%3Dvalue%26token%3D[REDACTED]%26lang%3Dzh_CN',
      escapedBody: 'payload= value\\u0026token=[REDACTED]\\u0026lang=zh_CN',
    });
  });

  it('redacts fingerprint assignments with whitespace before equals', () => {
    expect(redactText('request failed: fingerprint = fp-secret'))
      .toBe('request failed: fingerprint=[REDACTED]');
  });

  it('redacts quoted fingerprint assignments with whitespace before colon', () => {
    expect(redactText('request failed: fingerprint : "fp-secret"'))
      .toBe('request failed: fingerprint=[REDACTED]');
  });

  it('redacts Channels session credentials in nested objects without matching similar business fields', () => {
    expect(redactValue({
      requestBody: {
        rawKeyBuff: 'raw-secret',
        pluginSessionId: 'session-secret',
        nested: { RAW_KEY_BUFF: 'raw-snake-secret', plugin_session_id: 'session-snake-secret' },
        rawKeyBuffLength: 24,
        drawKeyBuff: 'visible',
        pluginSessionCount: 2,
      },
    })).toEqual({
      requestBody: {
        rawKeyBuff: '[REDACTED]',
        pluginSessionId: '[REDACTED]',
        nested: { RAW_KEY_BUFF: '[REDACTED]', plugin_session_id: '[REDACTED]' },
        rawKeyBuffLength: 24,
        drawKeyBuff: 'visible',
        pluginSessionCount: 2,
      },
    });
  });

  it('redacts Channels credentials in JSON request body previews retained by observation traces', () => {
    expect(redactValue({
      requestBody: '{"req":{"rawKeyBuff":"raw-secret","pluginSessionId":"session-secret","RAW_KEY_BUFF":"raw-snake-secret","PLUGIN_SESSION_ID":"session-snake-secret","rawKeyBuffLength":24,"pluginSessionCount":2}}',
    })).toEqual({
      requestBody: '{"req":{"rawKeyBuff":"[REDACTED]","pluginSessionId":"[REDACTED]","RAW_KEY_BUFF":"[REDACTED]","PLUGIN_SESSION_ID":"[REDACTED]","rawKeyBuffLength":24,"pluginSessionCount":2}}',
    });
  });

  it('redacts Channels credentials in diagnostic assignments without matching similar names', () => {
    expect(redactText('request failed: rawKeyBuff = raw-secret; pluginSessionId : "session-secret"; RAW_KEY_BUFF=raw-snake-secret; PLUGIN_SESSION_ID=session-snake-secret; drawKeyBuff=visible; rawKeyBuffLength=24; pluginSessionCount=2'))
      .toBe('request failed: rawKeyBuff=[REDACTED]; pluginSessionId=[REDACTED]; RAW_KEY_BUFF=[REDACTED]; PLUGIN_SESSION_ID=[REDACTED]; drawKeyBuff=visible; rawKeyBuffLength=24; pluginSessionCount=2');
  });

  it('redacts Channels credentials in URL query parameters while preserving unrelated parameters', () => {
    expect(redactUrl('https://channels.weixin.qq.com/api?rawKeyBuff=raw%2Bsecret&pluginSessionId=session-secret&RAW_KEY_BUFF=raw-snake-secret&PLUGIN_SESSION_ID=session-snake-secret&rawKeyBuffLength=24&pluginSessionCount=2'))
      .toBe('https://channels.weixin.qq.com/api?rawKeyBuff=[REDACTED]&pluginSessionId=[REDACTED]&RAW_KEY_BUFF=[REDACTED]&PLUGIN_SESSION_ID=[REDACTED]&rawKeyBuffLength=24&pluginSessionCount=2');
  });

  it('redacts Channels credentials in encoded query assignments in observation text', () => {
    expect(redactValue({
      requestBody: 'payload%3Dvalue%26rawKeyBuff%3Draw-secret%26pluginSessionId%3Dsession-secret%26lang%3Dzh_CN',
      escapedBody: 'payload=value\\u0026raw_key_buff=raw-snake-secret\\u0026PLUGIN_SESSION_ID=session-snake-secret\\u0026lang=zh_CN',
    })).toEqual({
      requestBody: 'payload%3Dvalue%26rawKeyBuff%3D[REDACTED]%26pluginSessionId%3D[REDACTED]%26lang%3Dzh_CN',
      escapedBody: 'payload=value\\u0026raw_key_buff=[REDACTED]\\u0026PLUGIN_SESSION_ID=[REDACTED]\\u0026lang=zh_CN',
    });
  });
});
