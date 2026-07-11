/**
 * @file Builds a standalone Windows .exe of Tablo4U.
 * Web assets (public/) are embedded via the "pkg".assets config in package.json.
 */

const exe = require('@hearhellacopters/exe');
const pak = require('./package.json');

const build = exe({
    entry: './src/server.js',
    out: './tablo4u-win-x64.exe',
    pkg: ['-C', 'GZip'],
    version: pak.version.split('-')[0],
    target: 'node24-win-x64',
    properties: {
        FileDescription: pak.description,
        ProductName: 'Tablo4U',
        ProductVersion: pak.version,
        OriginalFilename: 'tablo4u.exe',
        LegalCopyright: 'ISC'
    }
});

build.then(() => console.log('Windows build completed!'));
