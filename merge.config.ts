import { defineConfig } from '@playwright/test';

// Windows and Linux reports name different absolute checkout roots. One
// explicit tests root lets both normal reporting and failure selection merge
// their relative paths without treating them as unrelated source trees.
export default defineConfig({ testDir: './tests' });
