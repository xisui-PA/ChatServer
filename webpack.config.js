const path = require('path');

/**
 * @param {Record<string, unknown>} env
 * @param {{ mode?: 'development' | 'production' }} argv
 * @returns {import('webpack').Configuration}
 */
module.exports = (env, argv) => {
  const mode = argv.mode === 'development' ? 'development' : 'production';

  return {
    mode,
    target: 'node',
    entry: './src/index.ts',
    devtool: 'source-map',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'index.js',
      // Emit relative source paths so VS Code can map breakpoints back to src/.
      devtoolNamespace: '',
      // Remove stale files from previous builds.
      clean: true,
    },
    resolve: {
      extensions: ['.ts', '.js'],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: {
            loader: 'ts-loader',
            options: {
              configFile: 'tsconfig.json',
            },
          },
        },
      ],
    },
    externals: {
      // Optional native accelerators used by `ws`; loaded at runtime if installed.
      bufferutil: 'commonjs bufferutil',
      'utf-8-validate': 'commonjs utf-8-validate',
    },
    optimization: {
      // Keep the server bundle readable and fast to build.
      minimize: false,
    },
    stats: 'errors-warnings',
  };
};
