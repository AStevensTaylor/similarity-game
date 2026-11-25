const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// .pte = ExecuTorch model program.
// .tok = the model's tokenizer.json, renamed so Metro ships it as a file asset
//        instead of parsing it as a JavaScript module.
config.resolver.assetExts.push('pte', 'tok');

module.exports = config;
