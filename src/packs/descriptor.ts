import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';

/** protobufjs JSON descriptor of a .proto file, as stored in a decoder pack. */
export function protoDescriptor(protoFile: string): unknown {
  return protobuf.parse(readFileSync(protoFile, 'utf8'), { keepCase: false }).root.toJSON();
}
