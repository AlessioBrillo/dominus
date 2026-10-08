// SPDX-License-Identifier: AGPL-3.0-only
// standard-version updater: keeps the README version badge in step with a release.
const BADGE = /(badge\/version-)[0-9A-Za-z.\-]+(-blue)/;

module.exports.readVersion = (contents) => {
  const m = /badge\/version-([0-9A-Za-z.\-]+)-blue/.exec(contents);
  return m ? m[1] : '0.0.0';
};

module.exports.writeVersion = (contents, version) => contents.replace(BADGE, `$1${version}$2`);
