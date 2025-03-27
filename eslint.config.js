import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';

export default [
    eslint.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
        },
        rules: {
            'handle-callback-err': 'off',
            'no-console': 'off',
            'no-empty-function': 'error',
            'no-floating-decimal': 'error',
            'no-lonely-if': 'error',
            'no-multi-spaces': 'error',
            'no-shadow': ['error', { allow: ['err', 'resolve', 'reject'] }],
            'no-var': 'error',
            'no-undef': 'off',
            'prefer-const': 'error',
            yoda: 'error',
        },
    },
    eslintConfigPrettier,
];
