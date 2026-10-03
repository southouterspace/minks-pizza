"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

export function PrintButton() {
  return (
    <Button type="button" size="sm" onClick={() => window.print()}>
      <Printer aria-hidden="true" />
      Print
    </Button>
  );
}
