import type { useRouter } from "next/navigation";

type AppRouter = ReturnType<typeof useRouter>;
type PrefetchOptions = NonNullable<Parameters<AppRouter["prefetch"]>[1]>;

const FULL_PREFETCH_OPTIONS: PrefetchOptions = {
  kind: "full" as PrefetchOptions["kind"],
};

export function prefetchFullRoute(router: AppRouter, href: string) {
  router.prefetch(href, FULL_PREFETCH_OPTIONS);
}
