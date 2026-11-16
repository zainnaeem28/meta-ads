'use client';

import { useAdminGetSettings, useAdminSetSignupMode } from '@shroomap/contracts';
import { AdminShell } from '@shroomap/ui/cmp-031';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import type { NoticeAction } from '../../components/errors/ErrorNotice';
import { isApiClientError } from '../../lib/api/client';
import { signInUrl } from '../../lib/errors/session';
import { SETTINGS_COPY } from './copy';
import { SettingsView, type SignupMode } from './SettingsView';

const SETTINGS_PATH = '/admin/settings';

/**
 * SCREEN-013 at `/admin/settings`: API-120 loads the settings, API-121 saves the sign-up mode. A refusal
 * (`signup_open_prerequisites`) keeps the choice on the saved mode and explains what is missing; the step-up dialog
 * (`recent_auth_required`) sends the user to re-authenticate and nothing is resubmitted automatically.
 */
export function SettingsScreen() {
  const queryClient = useQueryClient();
  const query = useAdminGetSettings();
  const body = query.data?.data;
  const settings = body && 'data' in body ? body.data : undefined;
  const [choice, setChoice] = useState<SignupMode | null>(null);
  const [toasts, setToasts] = useState<{ id: string; variant: 'success'; message: string }[]>([]);
  const [saveError, setSaveError] = useState<unknown>(null);

  const save = useAdminSetSignupMode({
    mutation: {
      onSuccess: (response) => {
        queryClient.setQueryData(['/admin/settings'], response);
        setChoice(null);
        setSaveError(null);
        setToasts([{ id: 'saved', variant: 'success', message: SETTINGS_COPY.saved }]);
      },
      onError: (error) => {
        setSaveError(error);
        // The switch stays on the saved mode when the server refuses.
        if (isApiClientError(error) && error.code === 'signup_open_prerequisites') setChoice(null);
      },
    },
  });

  const onSaveErrorAction = useCallback((action: NoticeAction) => {
    if (action === 'confirm') window.location.assign(signInUrl(SETTINGS_PATH));
    else setSaveError(null);
  }, []);

  const forbidden = isApiClientError(query.error) && query.error.code === 'forbidden_role';
  const selected = choice ?? settings?.signupMode ?? 'invited_only';

  return (
    <AdminShell
      path={SETTINGS_PATH}
      pageName={SETTINGS_COPY.title}
      unavailable={forbidden}
      toasts={toasts}
      onDismissToast={() => setToasts([])}
    >
      <SettingsView
        settings={settings}
        selected={selected}
        onSelect={(mode) => {
          setChoice(mode);
          setSaveError(null);
          setToasts([]);
        }}
        onSave={() => save.mutate({ data: { mode: selected } })}
        saving={save.isPending}
        saveError={saveError}
        onSaveErrorAction={onSaveErrorAction}
        loadError={query.error}
        onRetryLoad={() => void query.refetch()}
      />
    </AdminShell>
  );
}
