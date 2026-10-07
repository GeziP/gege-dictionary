import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// `findBy…` and `waitFor` give up after a second by default. That is plenty on a quiet
// machine and too little on a busy one, where it turns a passing test red.
configure({ asyncUtilTimeout: 8000 });
