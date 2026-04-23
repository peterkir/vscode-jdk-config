import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Mocha from 'mocha';

export async function run(): Promise<void> {
  const mocha = new Mocha({
    color: true,
    ui: 'bdd'
  });

  const testsRoot = __dirname;
  const files = await fs.readdir(testsRoot);

  for (const file of files) {
    if (!file.endsWith('.test.js')) {
      continue;
    }

    mocha.addFile(path.join(testsRoot, file));
  }

  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} test(s) failed.`));
        return;
      }

      resolve();
    });
  });
}
