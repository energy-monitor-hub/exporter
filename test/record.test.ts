import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FixtureWriter, fixtureFileName, type FixtureIndex } from '../src/record/fixtures.js';
import { Scrubber } from '../src/record/scrub.js';
import { encodeHeaderMessage } from './helpers/proto.js';

const SN = 'R651ZTEST1234567';
const USER_ID = '1999999999999999999';
const MODULE_SN = 'M106ZTEST7654321';

const xor = (s: string, key: number) => Buffer.from(Buffer.from(s).map((b) => b ^ key));

describe('Scrubber', () => {
  it('replaces SN and userId with same-length placeholders, also inside XOR-ed pdata', () => {
    const s = new Scrubber([
      { value: SN, fill: 'X' },
      { value: USER_ID, fill: '0' },
    ]);
    const seq = 0x1234_56ab;
    const payload = encodeHeaderMessage([
      { pdata: Buffer.concat([Buffer.from('a'), xor(SN, seq & 0xff)]), encType: 1, seq, cmdFunc: 254, cmdId: 21, deviceSn: SN },
    ]);
    const { bytes, replaced } = s.scrubBytes(payload, [seq & 0xff]);
    expect(replaced).toBe(2);
    expect(bytes.length).toBe(payload.length);
    expect(bytes.includes(Buffer.from(SN))).toBe(false);
    expect(bytes.includes(xor(SN, seq & 0xff))).toBe(false);
    expect(bytes.includes(xor('X'.repeat(SN.length), seq & 0xff))).toBe(true);
    expect(s.scrubText(`/app/${USER_ID}/${SN}/thing/property/get_reply`)).toBe(
      `/app/${'0'.repeat(USER_ID.length)}/${'X'.repeat(SN.length)}/thing/property/get_reply`,
    );
  });

  it('learns module serials from headers', () => {
    const s = new Scrubber();
    expect(s.learnFromHeaders([{ cmdFunc: 1, cmdId: 1, pdataBytes: 0, moduleSn: MODULE_SN }])).toBe(1);
    expect(s.learnFromHeaders([{ cmdFunc: 1, cmdId: 1, pdataBytes: 0, moduleSn: MODULE_SN }])).toBe(0);
    expect(s.scrubText(MODULE_SN)).toBe('X'.repeat(MODULE_SN.length));
  });
});

describe('FixtureWriter', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('writes scrubbed .bin files and an index without any identifiers', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ef-fixtures-'));
    const scrubber = new Scrubber([{ value: SN, fill: 'X' }]);
    scrubber.add(USER_ID, '0');
    const writer = new FixtureWriter(dir, scrubber, new Date('2026-11-21T14:00:00Z'));
    await writer.init();

    // Message 1 mentions the module serial only inside pdata; message 2 announces it in the header.
    await writer.add({
      topic: `/app/device/property/${SN}`,
      kind: 'property',
      receivedAt: new Date('2026-11-21T14:00:01.5Z'),
      payload: encodeHeaderMessage([{ pdata: Buffer.from(`pack ${MODULE_SN}`), cmdFunc: 32, cmdId: 50, deviceSn: SN }]),
    });
    await writer.add({
      topic: `/app/${USER_ID}/${SN}/thing/property/get_reply`,
      kind: 'get_reply',
      receivedAt: new Date('2026-11-21T14:00:02Z'),
      payload: encodeHeaderMessage([
        { cmdFunc: 254, cmdId: 21, moduleSn: MODULE_SN },
        { cmdFunc: 254, cmdId: 22 },
      ]),
    });
    await writer.add({
      topic: `/app/device/property/${SN}`,
      kind: 'property',
      receivedAt: new Date('2026-11-21T14:00:03Z'),
      payload: Buffer.from(`{"sn":"${SN}"}`),
    });
    await writer.close(new Date('2026-11-21T14:10:00Z'));

    expect(writer.dir).toBe(join(dir, '20261121T140000000Z'));
    const files = (await readdir(writer.dir)).sort();
    expect(files).toEqual([
      '00001-20261121T140001500Z-32-50.bin',
      '00002-20261121T140002000Z-254-21-x2.bin',
      '00003-20261121T140003000Z-raw.bin',
      'index.json',
    ]);

    for (const f of files) {
      const content = await readFile(join(writer.dir, f));
      for (const secret of [SN, USER_ID, MODULE_SN]) expect(content.includes(Buffer.from(secret)), `${f} has ${secret}`).toBe(false);
    }

    const index = JSON.parse(await readFile(join(writer.dir, 'index.json'), 'utf8')) as FixtureIndex;
    expect(index).toMatchObject({ version: 1, session: '20261121T140000000Z', endedAt: '2026-11-21T14:10:00.000Z' });
    expect(index.counts).toEqual({ '32/50': 1, '254/21': 1, '254/22': 1, raw: 1 });
    expect(index.messages[1]).toMatchObject({ kind: 'get_reply', format: 'protobuf', topic: `/app/${'0'.repeat(19)}/${'X'.repeat(16)}/thing/property/get_reply` });
    expect(index.messages[2]?.format).toBe('raw');
  });

  it('names files by sequence, time and the first header', () => {
    const at = new Date('2026-01-02T03:04:05.006Z');
    expect(fixtureFileName(7, at, null)).toBe('00007-20260102T030405006Z-raw.bin');
    expect(fixtureFileName(7, at, [{ cmdFunc: 2, cmdId: 3, pdataBytes: 0 }])).toBe('00007-20260102T030405006Z-2-3.bin');
  });
});

describe('Scrubber.learnFromDecoded', () => {
  it('learns battery serials from decoded pdata, ignores filler like 0000…', () => {
    const s = new Scrubber();
    const added = s.learnFromDecoded([
      { data: { bmsSn: 'D3M1ZTEST0000001', packSn: 'D3M1ZTEST0000002', plugInInfoDcpSn: '0000000000000000' } },
      { data: { nested: { list: [{ devSn: 'ABCDZTEST0000003' }] }, hwVer: 'V0.0.0' } },
      { data: undefined },
    ]);
    expect(added).toBe(3);
    expect(s.scrubText('D3M1ZTEST0000001 ABCDZTEST0000003')).toBe(`${'X'.repeat(16)} ${'X'.repeat(16)}`);
  });
});
