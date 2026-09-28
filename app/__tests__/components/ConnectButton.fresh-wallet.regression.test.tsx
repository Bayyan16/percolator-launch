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
      preferredAddress: null,
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

    // Deliberately keep the old Phantom as the user's primary wallet.
    // The regression must NOT rely on user.wallet.
    user: {
      wallet: {
        address: "PHANTOM_OLD_ADDRESS",
      },
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
        address: "PHANTOM_OLD_ADDRESS",
        standardWallet: { name: "Phantom" },
      },
      {
        address: "SOLFLARE_NEW_LOGIN_ADDRESS",
        standardWallet: { name: "Solflare" },
      },
    ],
  }),
  useFundWallet: () => ({
    fundWallet: vi.fn(),
  }),
}));

import { ConnectButtonPrivyInner as ConnectButton } from "@/components/wallet/ConnectButtonPrivyInner";

describe("fresh wallet authentication regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loginCallbacks.current = null;
  });

  it("binds the Solana wallet actually used by Privy login", () => {
    render(<ConnectButton />);

    expect(loginCallbacks.current?.onComplete).toBeTypeOf("function");

    act(() => {
      loginCallbacks.current.onComplete({
        user: {},
        isNewUser: false,
        wasAlreadyAuthenticated: false,
        loginMethod: "wallet",
        loginAccount: {
          type: "wallet",
          address: "SOLFLARE_NEW_LOGIN_ADDRESS",
          chainType: "solana",
          walletClientType: "solflare",
        },
      });
    });

    expect(mockSetPreferredAddress).toHaveBeenCalledTimes(1);
    expect(mockSetPreferredAddress).toHaveBeenCalledWith(
      "SOLFLARE_NEW_LOGIN_ADDRESS",
    );
  });
});
