import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockLogin,
  mockSetPreferredAddress,
  loginCallbacks,
} = vi.hoisted(() => ({
  mockLogin: vi.fn(),
  mockSetPreferredAddress: vi.fn(),
  loginCallbacks: {
    current: null as any,
  },
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ network: "devnet" }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: any) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/hooks/usePreferredWallet", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/usePreferredWallet")>();

  return {
    ...actual,
    usePreferredWallet: () => ({
      preferredAddress: "PHANTOM_MANUAL_ADDRESS",
      setPreferredAddress: mockSetPreferredAddress,
    }),
  };
});

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({
    ready: true,
    authenticated: false,
    logout: vi.fn(),
    exportWallet: vi.fn(),
    user: {
      linkedAccounts: [],
    },
  }),

  useLogin: (callbacks: any) => {
    loginCallbacks.current = callbacks;
    return {
      login: mockLogin,
    };
  },
}));

vi.mock("@privy-io/react-auth/solana", () => ({
  useWallets: () => ({
    wallets: [
      {
        address: "PHANTOM_MANUAL_ADDRESS",
        standardWallet: { name: "Phantom" },
      },
    ],
  }),
  useFundWallet: () => ({
    fundWallet: vi.fn(),
  }),
}));

import { ConnectButtonPrivyInner as ConnectButton } from "@/components/wallet/ConnectButtonPrivyInner";

describe("wallet login negative control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loginCallbacks.current = null;
  });

  it("does not replace the active wallet for a non-wallet login", () => {
    render(<ConnectButton />);

    expect(loginCallbacks.current?.onComplete).toBeTypeOf("function");

    act(() => {
      loginCallbacks.current.onComplete({
        user: {},
        isNewUser: false,
        wasAlreadyAuthenticated: false,
        loginMethod: "email",
        loginAccount: {
          type: "email",
          address: "user@example.test",
        },
      });
    });

    expect(mockSetPreferredAddress).not.toHaveBeenCalled();
  });
});
