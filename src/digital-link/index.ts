export {
  fromDigitalLink,
  parseDigitalLink,
  tryFromDigitalLink,
  tryParseDigitalLink,
} from './api.ts';
export type { DigitalLink, DigitalLinkParseOptions } from './api.ts';
export type { DigitalLinkErrorReason } from './errors.ts';
export { DEFAULT_DIGITAL_LINK_DOMAIN, toDigitalLink, tryToDigitalLink } from './build.ts';
export type { DigitalLinkOptions } from './build.ts';
