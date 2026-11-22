import { describe, expect, it } from 'vitest';
import { peekHeaders } from '../src/mqtt/header.js';
import { encodeLatestQuotasRequest } from '../src/mqtt/quota.js';
import { readFields } from '../src/mqtt/wire.js';
import { deviceTopics, subscribeTopics, topicKind } from '../src/mqtt/topics.js';
import { encodeHeaderMessage } from './helpers/proto.js';

describe('protobuf envelope peek', () => {
  it('reads cmdFunc/cmdId and serials of every header', () => {
    const payload = encodeHeaderMessage([
      { pdata: Uint8Array.of(8, 1), src: 2, dest: 32, cmdFunc: 254, cmdId: 21, seq: 123456, deviceSn: 'R651TEST0001' },
      { pdata: Uint8Array.of(), cmdFunc: 32, cmdId: 50, moduleSn: 'M101TEST0002', encType: 1, seq: -5 },
    ]);
    const headers = peekHeaders(payload);
    expect(headers).toHaveLength(2);
    expect(headers![0]).toMatchObject({ cmdFunc: 254, cmdId: 21, src: 2, dest: 32, seq: 123456, pdataBytes: 2, deviceSn: 'R651TEST0001' });
    expect(headers![1]).toMatchObject({ cmdFunc: 32, cmdId: 50, encType: 1, seq: -5, moduleSn: 'M101TEST0002' });
  });

  it('returns null for JSON and garbage', () => {
    expect(peekHeaders(Buffer.from('{"params":{}}'))).toBeNull();
    expect(peekHeaders(Buffer.from([0xff, 0xff, 0xff]))).toBeNull();
    expect(peekHeaders(Buffer.alloc(0))).toBeNull();
  });

  it('encodes the latest-quotas request like ioBroker', () => {
    const msg = encodeLatestQuotasRequest(1000);
    const [outer] = readFields(msg);
    expect(outer?.field).toBe(1);
    const inner = readFields(outer!.value as Uint8Array);
    const ints = Object.fromEntries(inner.filter((f) => f.wireType === 0).map((f) => [f.field, Number(f.value)]));
    expect(ints).toEqual({ 2: 32, 3: 32, 14: 1000 });
    const from = inner.find((f) => f.field === 23);
    expect(Buffer.from(from!.value as Uint8Array).toString()).toBe('ios');
  });
});

describe('topics', () => {
  it('builds the app topics and classifies incoming ones', () => {
    const t = deviceTopics('42', 'SN1');
    expect(subscribeTopics(t)).toEqual([
      '/app/device/property/SN1',
      '/app/42/SN1/thing/property/get_reply',
      '/app/42/SN1/thing/property/set_reply',
    ]);
    expect(t.get).toBe('/app/42/SN1/thing/property/get');
    expect(topicKind(t.property)).toBe('property');
    expect(topicKind(t.getReply)).toBe('get_reply');
    expect(topicKind(t.setReply)).toBe('set_reply');
    expect(topicKind('/x')).toBe('other');
  });
});
