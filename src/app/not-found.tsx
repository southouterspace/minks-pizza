import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

export default function NotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-32">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileQuestion aria-hidden />
          </EmptyMedia>
          <p className="font-mono text-sm text-muted-foreground">404</p>
          <EmptyTitle className="text-2xl! font-bold! tracking-tight">
            Page not found
          </EmptyTitle>
          <EmptyDescription>
            The page you&apos;re looking for doesn&apos;t exist.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Link
            href="/"
            className={cn(buttonVariants({ size: "lg" }), "h-10! px-5!")}
          >
            Back to the menu
          </Link>
        </EmptyContent>
      </Empty>
    </div>
  );
}
