/**
 * Thin wrapper around `@changesets/changelog-github` that rewrites the
 * sycophantic "Thanks @<login>!" credit to "by <Name>" using a small
 * GitHub-login → display-name map, falling back to `by @<login>` for
 * unmapped contributors. Solo-maintained repo today, but the fallback
 * keeps the behavior sensible if anyone else ever lands a PR.
 */
const github = require('@changesets/changelog-github').default;

const NAME_MAP = {
  KennyVaneetvelde: 'Kenny',
};

function rewriteThanks(line) {
  return line.replace(/ Thanks ([^!]+)!/g, (_match, users) => {
    const rewritten = users.replace(
      /\[@(\w[\w-]*)\]\(([^)]+)\)/g,
      (_, login) => NAME_MAP[login] ?? `@${login}`,
    );
    return ` by ${rewritten}`;
  });
}

module.exports = {
  default: {
    getDependencyReleaseLine: github.getDependencyReleaseLine,
    getReleaseLine: async (changeset, type, options) => {
      const line = await github.getReleaseLine(changeset, type, options);
      return rewriteThanks(line);
    },
  },
};
