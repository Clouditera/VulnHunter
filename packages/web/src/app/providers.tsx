import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastHost } from "../shared/toast/toast.js";
import { ConfirmHost } from "../shared/confirm/confirm.js";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
});

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <ToastHost />
      <ConfirmHost />
    </QueryClientProvider>
  );
}
