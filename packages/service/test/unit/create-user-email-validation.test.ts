import { beforeEach, describe, expect, it, vi } from "vitest";

const hash = vi.fn(async () => "hashed-password");
const createUser = vi.fn(async (params) => ({ id: "user-1", ...params }));

vi.mock("bcrypt", () => ({
  default: { hash, compare: vi.fn() },
}));

vi.mock("../../src/features/auth/storage.js", () => ({
  createUser,
}));

const { createUserAccount } = await import("../../src/features/auth/service.js");

describe("createUserAccount email validation", () => {
  beforeEach(() => {
    hash.mockClear();
    createUser.mockClear();
  });

  it.each(["not-an-email", "missing-domain@", "@missing-local.com", "a@b", "a b@example.com"])(
    "rejects invalid email %j before hashing or persistence",
    async (email) => {
      await expect(
        createUserAccount({
          email,
          password: "Passw0rd!",
          role: "member",
        }),
      ).rejects.toMatchObject({ code: "ERR_VALIDATION" });

      expect(hash).not.toHaveBeenCalled();
      expect(createUser).not.toHaveBeenCalled();
    },
  );

  it("normalizes a valid email", async () => {
    await createUserAccount({
      email: "  User@Example.COM  ",
      password: "Passw0rd!",
      role: "member",
    });

    expect(hash).toHaveBeenCalledOnce();
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({ email: "user@example.com" }));
  });
});
