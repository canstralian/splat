import { useEffect } from "react";

const SOCIAL_IMAGE =
  "https://storage.googleapis.com/gpt-engineer-file-uploads/KoUaltGzqoVfSfQv3CIsHyhMxAp2/social-images/social-1774040197142-Splat-Lovable-03-20-2026_04_56_PM.webp";

/**
 * Injects Schema.org JSON-LD into <head> at runtime, using the live
 * window.location.origin so URLs automatically track whatever domain
 * (preview, lovable.app, or custom) is serving the page.
 */
const StructuredData = () => {
  useEffect(() => {
    const origin = window.location.origin;
    const orgId = `${origin}/#organization`;

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

    const nodes: HTMLScriptElement[] = [];
    for (const [id, data] of [
      ["ld-organization", organization],
      ["ld-software-application", application],
    ] as const) {
      // Replace any existing block (e.g. across hot reloads / route changes).
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
  }, []);

  return null;
};

export default StructuredData;
