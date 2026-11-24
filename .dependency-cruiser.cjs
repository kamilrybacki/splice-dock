// Layer rules for src/. See docs/architecture.md.
// Service adapters (src/services/<svc>/adapters/**) and root files (src/*.ts)
// are exempt: no rule below matches them as the importing side.

const CORE = '^src/services/[^/]+/(?!adapters/)';

// Anything that is not a local source file: node builtins and npm packages.
const PACKAGE_TYPES = [
  'core', 'npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-bundled', 'npm-no-pkg', 'npm-unknown',
];

// Module id of a package import: node builtins (with or without `node:`), or
// the package directory inside node_modules (scoped names keep both segments).
const pkg = names => names.map(n => (n.startsWith('node:')
  ? `^(node:)?${n.slice(5).replace(/\//g, '\\/')}$`
  : `(^|/)node_modules/${n.replace(/\//g, '\\/')}/`));

function layer(name, from, allowedLocal, packages) {
  const rules = [
    {
      name: `${name}-local-imports`,
      comment: `${name} may only import: ${allowedLocal.join(', ') || 'nothing'}`,
      severity: 'error',
      from: { path: from },
      to: { path: '^src/', pathNot: allowedLocal },
    },
    {
      name: `${name}-packages`,
      comment: `${name} may only import allowlisted packages`,
      severity: 'error',
      from: { path: from },
      to: { dependencyTypes: PACKAGE_TYPES, pathNot: pkg(packages) },
    },
  ];
  return rules;
}

const common = '^src/common/';
const config = '^src/config/';
const contracts = '^src/contracts/(internal|outbound|inbound)/';
const services = '^src/services/[^/]+/(?!adapters/)';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    ...layer('common', '^src/common/', [common], ['node:async_hooks', 'node:crypto']),
    ...layer('contracts', '^src/contracts/', [common, config, contracts], []),
    ...layer('config', '^src/config/', [common, config, contracts, services], ['zod']),
    ...layer('core', CORE, [common, config, contracts, services],
      ['node:crypto', 'node:path', 'node:timers/promises', 'zod', 'minimatch']),
    {
      name: 'unknown-layer',
      comment: 'Every file under src/ is a root file or belongs to a known layer (docs/architecture.md).',
      severity: 'error',
      from: {
        path: '^src/',
        pathNot: ['^src/[^/]+$', common, config, contracts, '^src/services/[^/]+/'],
      },
      to: {},
    },
    {
      name: 'no-unresolvable-in-layers',
      comment: 'Imports in layered code must resolve (also catches typos and non-literal dynamic imports).',
      severity: 'error',
      from: { path: '^src/(common|config|contracts|services/[^/]+/(?!adapters/))' },
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    extraExtensionsToScan: [],
    includeOnly: undefined,
    moduleSystems: ['es6', 'cjs'],
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
    },
  },
};
