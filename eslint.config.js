import js from '@eslint/js'
import ts from 'typescript-eslint'
export default ts.config({ ignores: ['.tmp/**', 'results/**', 'site/**'] }, js.configs.recommended, ...ts.configs.recommended, { files: ['**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-empty-function': 'off', '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } })
