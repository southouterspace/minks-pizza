import Link from "next/link";
import { requireOperator } from "@/lib/auth";
import { formatPhone, tierFor } from "@/lib/loyalty";
import { getLoyaltySettings, searchMembers } from "@/lib/loyalty-server";
import { formatDateTime } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

export default async function LoyaltyMembersPage({ searchParams }: PageProps<"/admin/loyalty/members">) {
  await requireOperator();
  const q = String((await searchParams).q ?? "").slice(0, 60);
  const [settings, members] = await Promise.all([getLoyaltySettings(), searchMembers(q)]);
  const tiered = settings.tiers.length > 1;

  return (
    <div className="space-y-4">
      <form className="flex max-w-md gap-2" role="search">
        <Input name="q" defaultValue={q} placeholder="Phone digits or name" aria-label="Search members" />
        <Button type="submit" variant="outline" className="h-9!">
          Search
        </Button>
      </form>

      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {q ? `No members match "${q}".` : "No members yet. Customers join at checkout."}
        </p>
      ) : (
        <Card className="py-0!">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                {tiered ? <TableHead>Tier</TableHead> : null}
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Lifetime</TableHead>
                <TableHead className="hidden md:table-cell">Last order</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => (
                <TableRow key={m.id} data-testid="member-row">
                  <TableCell>
                    <Link href={`/admin/loyalty/members/${m.id}`} className="font-medium hover:underline">
                      {m.name ?? "No name"}
                    </Link>
                    <span className="block text-xs text-muted-foreground">{formatPhone(m.phone)}</span>
                  </TableCell>
                  {tiered ? <TableCell>{tierFor(m.qualifyingPoints, settings.tiers).name}</TableCell> : null}
                  <TableCell className="text-right tabular-nums">{m.pointsBalance.toLocaleString()}</TableCell>
                  <TableCell className="hidden text-right tabular-nums sm:table-cell">
                    {m.lifetimePoints.toLocaleString()}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    {formatDateTime(m.lastActivityAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
