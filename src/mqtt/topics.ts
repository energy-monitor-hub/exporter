export type TopicKind = 'property' | 'get_reply' | 'set_reply' | 'other';

export interface DeviceTopics {
  /** Telemetry the device pushes on its own. */
  property: string;
  get: string;
  getReply: string;
  set: string;
  setReply: string;
}

export function deviceTopics(userId: string, sn: string): DeviceTopics {
  const base = `/app/${userId}/${sn}/thing/property`;
  return {
    property: `/app/device/property/${sn}`,
    get: `${base}/get`,
    getReply: `${base}/get_reply`,
    set: `${base}/set`,
    setReply: `${base}/set_reply`,
  };
}

/** What we subscribe to: telemetry plus answers to our own requests. Read only. */
export function subscribeTopics(t: DeviceTopics): string[] {
  return [t.property, t.getReply, t.setReply];
}

export function topicKind(topic: string): TopicKind {
  if (topic.startsWith('/app/device/property/')) return 'property';
  if (topic.endsWith('/get_reply')) return 'get_reply';
  if (topic.endsWith('/set_reply')) return 'set_reply';
  return 'other';
}
