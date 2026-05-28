import antfu from '@antfu/eslint-config'
import pluginOxlint from 'eslint-plugin-oxlint'

export default antfu(
  {
    ignores: ['pnpm-workspace.yaml'],
  },
  {
    rules: {
      'unused-imports/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrors: 'none',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  pluginOxlint.configs['flat/recommended'],
)
