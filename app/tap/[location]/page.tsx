import TapClient from "../TapClient";
import { isLocation, LOCATIONS } from "@/lib/constants";

export function generateStaticParams() {
  return LOCATIONS.map((location) => ({ location }));
}

export default async function TapLocationPage({
  params,
}: {
  params: Promise<{ location: string }>;
}) {
  const { location } = await params;
  return <TapClient location={isLocation(location) ? location : undefined} />;
}
