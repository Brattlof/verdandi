/**
 * Bun before 1.4.2 never finishes `server.stop()` once a WebSocket has connected, so goldiloopd
 * could not shut down. `engines` isn't enforced when running scripts, so check at startup.
 */
export const requireBun = (version: string) => {
  if (!Bun.semver.satisfies(version, ">=1.4.2")) {
    throw new Error(`Goldiloop needs Bun 1.4.2 or newer (this is ${version}). Run \`bun upgrade\`.`);
  }
};
