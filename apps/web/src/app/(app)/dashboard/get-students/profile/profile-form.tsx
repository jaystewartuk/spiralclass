"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/components/locale-provider";
import { saveMarketingProfileAction, type MarketingState } from "@/app/actions/marketing";

export type ProfileFormValues = {
  audiences: string[];
  learnerLocations: string[];
  levels: string[];
  differentiator: string | null;
  weeklyMinutes: number;
  goalNewStudentsPerMonth: number;
};

// Four fields, on purpose.
//
// Everything else the generator needs — what she teaches, her prices, her
// packages, her open days, her testimonials, her bio, her photo — is read off
// the account she already maintains. A teacher will not fill in a twenty-field
// marketing questionnaire, and a product that needs one has already lost.
export function MarketingProfileForm({ values }: { values: ProfileFormValues }) {
  const t = useT();
  const [state, action, pending] = useActionState<MarketingState, FormData>(
    saveMarketingProfileAction,
    undefined,
  );

  return (
    <form action={action} className="space-y-5">
      <div className="space-y-1">
        <Label htmlFor="audiences">{t("web.getStudents.audiences")}</Label>
        <Input id="audiences" name="audiences" defaultValue={values.audiences.join(", ")} />
        <p className="text-muted-foreground text-xs">{t("web.getStudents.audiencesHelp")}</p>
      </div>

      <div className="space-y-1">
        <Label htmlFor="learnerLocations">{t("web.getStudents.learnerLocations")}</Label>
        <Input
          id="learnerLocations"
          name="learnerLocations"
          defaultValue={values.learnerLocations.join(", ")}
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="levels">{t("web.getStudents.levels")}</Label>
        <Input id="levels" name="levels" defaultValue={values.levels.join(", ")} />
      </div>

      <div className="space-y-1">
        <Label htmlFor="differentiator">{t("web.getStudents.differentiator")}</Label>
        <Textarea
          id="differentiator"
          name="differentiator"
          rows={3}
          maxLength={240}
          defaultValue={values.differentiator ?? ""}
        />
        <p className="text-muted-foreground text-xs">{t("web.getStudents.differentiatorHelp")}</p>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="weeklyMinutes">{t("web.getStudents.weeklyMinutes")}</Label>
          <Input
            id="weeklyMinutes"
            name="weeklyMinutes"
            type="number"
            min={15}
            max={300}
            step={15}
            defaultValue={values.weeklyMinutes}
          />
          <p className="text-muted-foreground text-xs">{t("web.getStudents.weeklyMinutesHelp")}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="goalNewStudentsPerMonth">{t("web.getStudents.goal")}</Label>
          <Input
            id="goalNewStudentsPerMonth"
            name="goalNewStudentsPerMonth"
            type="number"
            min={1}
            max={50}
            defaultValue={values.goalNewStudentsPerMonth}
          />
        </div>
      </div>

      {state?.error && (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      )}
      {state?.ok && (
        <p className="text-muted-foreground text-sm">{t("web.getStudents.profileSaved")}</p>
      )}
      <Button type="submit" disabled={pending}>
        {t("web.getStudents.saveProfile")}
      </Button>
    </form>
  );
}
