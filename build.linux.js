/**
 * @file Builds a standalone Linux binary of Tablo4U (used to verify the
 * packaged-app paths and embedded assets; the Windows build is produced in CI).
 */

const { exec } = require('@yao-pkg/pkg');

exec(['src/server.js', '--targets', 'node22-linux-x64', '--output', 'tablo4u-linux-x64', '-C', 'GZip'])
    .then(() => console.log('Linux build completed!'))
    .catch((e) => { console.error(e); process.exit(1); });
