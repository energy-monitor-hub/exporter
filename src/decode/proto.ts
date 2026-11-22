import { readAsset } from '../assets.js';
import protobuf from 'protobufjs';

/** Message type names per cmdFunc/cmdId for Delta 3 Max Plus (ioBroker `protoMsg`). */
export const MESSAGE_TYPES: Readonly<Record<string, string>> = {
  '32/2': 'CMSHeartBeatReport',
  '32/50': 'BMSHeartBeatReport',
  '50/2': 'AppRuquestBpEuLawDataAck',
  '50/98': 'AppRuquestBpEuLawData',
  '254/17': 'set_dp3',
  '254/18': 'setReply_dp3',
  '254/19': 'ConfigRead',
  '254/20': 'ConfigReadAck',
  '254/21': 'DisplayPropertyUpload',
  '254/22': 'RuntimePropertyUpload',
};

let root: protobuf.Root | undefined;

/**
 * The parsed .proto (src/proto/delta3maxplus.proto). The file is read next to the compiled
 * module: `npm run build` copies it to dist/proto.
 */
export function protoRoot(): protobuf.Root {
  if (!root) {
    const file = readAsset('proto/delta3maxplus.proto', () => new URL('../proto/delta3maxplus.proto', import.meta.url));
    if (!file) throw new Error('proto/delta3maxplus.proto is missing');
    const source = file.toString('utf8');
    root = protobuf.parse(source, { keepCase: false }).root;
  }
  return root;
}

export function lookupType(name: string): protobuf.Type {
  return protoRoot().lookupType(name);
}
