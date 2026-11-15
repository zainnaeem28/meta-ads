// expect: shroomap.egress.no-raw-http-outside-platform-egress
import https from 'node:https';

export const agent = https;
