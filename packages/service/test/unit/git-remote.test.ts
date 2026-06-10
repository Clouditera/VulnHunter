import { describe, expect, it } from "vitest";
import {
  GitRemoteError,
  parseDefaultBranch,
  parseRemoteBranches,
  validateRemoteGitUrl,
} from "../../src/features/files/git-remote.js";

describe("git remote helpers", () => {
  it("parses default branch from ls-remote --symref HEAD", () => {
    const out = "ref: refs/heads/master\tHEAD\nabc123\tHEAD\n";
    expect(parseDefaultBranch(out)).toBe("master");
  });

  it("returns null when remote does not expose a symref", () => {
    expect(parseDefaultBranch("abc123\tHEAD\n")).toBeNull();
  });

  it("parses and sorts remote heads", () => {
    const out = [
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/release/1.0",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/main",
      "cccccccccccccccccccccccccccccccccccccccc\trefs/tags/v1",
    ].join("\n");
    expect(parseRemoteBranches(out)).toEqual(["main", "release/1.0"]);
  });

  it("accepts http(s) URLs and trims whitespace", () => {
    expect(validateRemoteGitUrl(" https://github.com/pallets/flask.git ")).toBe("https://github.com/pallets/flask.git");
    expect(validateRemoteGitUrl("http://example.com/repo.git")).toBe("http://example.com/repo.git");
  });

  it("rejects leading dash and non-http schemes", () => {
    for (const url of ["-foo", "--upload-pack=/tmp/x", "file:///etc/passwd", "ssh://github.com/a/b.git", "git@github.com:a/b.git", "not a url"]) {
      expect(() => validateRemoteGitUrl(url), url).toThrow(GitRemoteError);
    }
  });
});
