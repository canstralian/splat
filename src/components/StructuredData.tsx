import { useEffect } from "react";
import { useLocation } from "react-router-dom";

const SOCIAL_IMAGE =
  "https://storage.googleapis.com/gpt-engineer-file-uploads/KoUaltGzqoVfSfQv3CIsHyhMxAp2/social-images/social-1774040197142-Splat-Lovable-03-20-2026_04_56_PM.webp";

type PageMeta = {
  headline: string;
  description: string;
  type?: string;
};

const PAGE_META: Record<string, PageMeta> = {
  "/": {
    headline: "Splat — Crush bugs faster. Ship more.",
    description:
      "The bug tracker built for indie developers and small studios.",
  },
  "/dashboard": {
    headline: "Dashboard — Splat",
    description:
      "Real-time overview of bugs, severity distribution, and workflow status in Splat.",
  },
  "/bugs": {
    headline: "Bugs — Splat",
    description:
      "Browse, search, and triage every bug across your Splat workspace.",
  },
  "/bugs/new": {
    headline: "Report a bug — Splat",
    description:
      "Capture a new bug with severity, category, and reproduction details.",
  },
  "/analytics": {
    headline: "Analytics — Splat",
    description:
      "Visualize bug trends, throughput, and severity breakdowns over time.",
  },
  "/settings": {
    headline: "Settings — Splat",
    description: "Manage your Splat profile, workspace, and preferences.",
  },
  "/auth": {
    headline: "Sign in — Splat",
    description: "Sign in or create your Splat account to start tracking bugs.",
  },
};

const matchMeta = (pathname: string): PageMeta => {
  if (PAGE_META[pathname]) return PAGE_META[pathname];
  if (pathname.startsWith("/bugs/")) {
    return {
      headline: "Bug detail — Splat",
      description:
        "Inspect a bug's status, severity, comments, and activity in Splat.",
    };
  }
  return PAGE_META["/"];
};

/**
 * Injects Schema.org JSON-LD into <head> at runtime, using the live
 * window.location.origin so URLs automatically track whatever domain
 * (preview, lovable.app, or custom) is serving the page. Adds a
 * page-specific WebPage node alongside the global Organization and
 * SoftwareApplication nodes.
 */
const StructuredData = () => {
  const { pathname } = useLocation();

  useEffect(() => {
    const origin = window.location.origin;
    const orgId = `${origin}/#organization`;
    const appId = `${origin}/#software`;
    const pageUrl = `${origin}${pathname}`;
    const pageId = `${pageUrl}#webpage`;
    const meta = matchMeta(pathname);

    const organization = {
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": orgId,
      name: "Splat",
      url: origin,
      logo: `${origin}/favicon.ico`,
      description:
        "Splat is a lightweight bug tracker built for indie developers and small studios.",
      sameAs: [],
    };

    const application = {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      "@id": appId,
      name: "Splat",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Web",
      description:
        "The bug tracker for indie devs and small studios. Crush bugs faster. Ship more.",
      url: origin,
      image: SOCIAL_IMAGE,
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
      },
      publisher: { "@id": orgId },
    };

    const webPage = {
      "@context": "https://schema.org",
      "@type": "WebPage",
      "@id": pageId,
      url: pageUrl,
      name: meta.headline,
      headline: meta.headline,
      description: meta.description,
      isPartOf: { "@id": appId },
      about: { "@id": orgId },
      publisher: { "@id": orgId },
      primaryImageOfPage: SOCIAL_IMAGE,
      inLanguage: "en",
    };

    const nodes: HTMLScriptElement[] = [];
    for (const [id, data] of [
      ["ld-organization", organization],
      ["ld-software-application", application],
      ["ld-webpage", webPage],
    ] as const) {
      document.getElementById(id)?.remove();
      const script = document.createElement("script");
      script.type = "application/ld+json";
      script.id = id;
      script.text = JSON.stringify(data);
      document.head.appendChild(script);
      nodes.push(script);
    }

    return () => {
      nodes.forEach((n) => n.remove());
    };
  }, [pathname]);

  return null;
};

export default StructuredData;
