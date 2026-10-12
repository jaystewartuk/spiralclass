"use client";

import { useMemo, useState } from "react";
import { useDeviceTimezone } from "@/hooks/use-device-timezone";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// The time-zone field both contact forms post: a quick-pick list plus a hidden
// `timezone` input. The saved zone is always one of the options, so a zone
// missing from the quick-pick list (a student saved as Europe/Vienna) still
// shows as selected instead of reading as "not set".
//
// `includeDeviceZone` adds the zone this browser is in — right when the person
// editing is the person the zone belongs to (their own account page), wrong on
// the teacher's roster edit, where it would offer the teacher's own city as
// the student's.

export function TimezoneSelect({
  id,
  label,
  placeholder,
  hint,
  initialTimezone,
  options,
  includeDeviceZone = false,
}: {
  id: string;
  label: string;
  placeholder: string;
  hint: string;
  initialTimezone: string | null;
  options: readonly string[];
  includeDeviceZone?: boolean;
}) {
  const detected = useDeviceTimezone(includeDeviceZone);

  const zones = useMemo(() => {
    const set = new Set(options);
    if (detected) set.add(detected);
    if (initialTimezone) set.add(initialTimezone);
    return Array.from(set).sort();
  }, [options, detected, initialTimezone]);

  const [timezone, setTimezone] = useState<string>(initialTimezone ?? "");

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Select value={timezone || undefined} onValueChange={setTimezone}>
        <SelectTrigger id={id} aria-describedby={`${id}-hint`}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {zones.map((z) => (
            <SelectItem key={z} value={z}>
              {z}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <input type="hidden" name="timezone" value={timezone} />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}
