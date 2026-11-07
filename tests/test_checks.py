"""Lance les vérifications isolées (modules Python avec substituts Flask, interface JavaScript)
dans des processus séparés, pour qu'elles n'interfèrent pas avec les tests HTTP."""
import os
import shutil
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


class IsolatedChecks(unittest.TestCase):
    def run_check(self, cmd):
        r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=300)
        self.assertEqual(r.returncode, 0, r.stdout[-2000:] + r.stderr[-2000:])
        self.assertIn("PASS", r.stdout)

    def test_modules(self):
        self.run_check([sys.executable, "-B", os.path.join(HERE, "modules_check.py")])

    @unittest.skipUnless(shutil.which("node"), "Node.js non installé : vérification de l'interface ignorée")
    def test_interface_js(self):
        self.run_check(["node", os.path.join(HERE, "frontend_check.js")])


if __name__ == "__main__":
    unittest.main(verbosity=2)
