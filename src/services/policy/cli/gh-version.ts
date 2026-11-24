/** The gh release the built-in gh tables (known commands, flag arity) were
 *  verified against. The Dockerfile `ARG GH_VERSION` and the example config's
 *  self-provisioning step must match it; tests assert both, and the help
 *  verification test checks the tables against this exact gh build. */
export const PINNED_GH_VERSION = '2.102.0';
