/*
  Runtime file: do not modify for normal setup.
  Configure the application via root config.js.
*/

function createSettingsController({
  controls,
  getStoredSettings,
  persistSettings,
  activeAdapterId,
  appUseSandbox,
  resolveEnvironmentConfigKey,
  getAdapterFactory,
  getAdapterConfigs,
  showToast,
} = {}) {
  const AUTO_CONNECT_AFTER_RELOAD_KEY = 'quickstrike.autoConnectAfterReload';

  const {
    btnConnect,
    configAdapterSelect,
    configEnvSelect,
    configTastyTradeFields,
    configClientIdInput,
    configClientSecretInput,
    configIbkrFields,
    configIbkrPlatformSelect,
    configIbkrIpInput,
    configIbkrTwsPrereq,
    configIbkrApiSettingsPath,
    configIbkrActiveXItem,
    configIbkrSocketPort,
  } = controls ?? {};

  let envMutationLock = false;
  let lastKnownEnvValue = 'sandbox';

  function getCurrentSettings() {
    return getStoredSettings?.() ?? {};
  }

  function getAllAdapterConfigs() {
    return getAdapterConfigs?.() ?? window.ADAPTER_CONFIGS ?? {};
  }

  function updateConnectButtonLabel(selectedAdapterId) {
    if (!btnConnect) return;
    btnConnect.textContent = selectedAdapterId === 'tastytrade' ? 'Login' : 'Connect';
  }

  function resolveIbkrPort({ platform, useSandboxMode }) {
    const ibkrConfig = getAllAdapterConfigs()?.ibkr ?? {};
    const ibGatewayLivePort = Number.parseInt(ibkrConfig.ibGatewayLivePort, 10);
    const ibGatewayPaperPort = Number.parseInt(ibkrConfig.ibGatewayPaperPort, 10);
    const twsLivePort = Number.parseInt(ibkrConfig.twsLivePort, 10);
    const twsPaperPort = Number.parseInt(ibkrConfig.twsPaperPort, 10);

    const normalizedPlatform = `${platform ?? ''}`.trim().toLowerCase();
    if (normalizedPlatform === 'gateway') {
      if (useSandboxMode) {
        return Number.isFinite(ibGatewayPaperPort) ? ibGatewayPaperPort : 4002;
      }

      return Number.isFinite(ibGatewayLivePort) ? ibGatewayLivePort : 4001;
    }

    if (useSandboxMode) {
      return Number.isFinite(twsPaperPort) ? twsPaperPort : 7496;
    }

    return Number.isFinite(twsLivePort) ? twsLivePort : 7497;
  }

  function updateIbkrPortNote() {
    if (!configIbkrPlatformSelect || !configEnvSelect) return;

    const selectedPlatform = configIbkrPlatformSelect.value;
    const selectedUseSandbox = configEnvSelect.value === 'sandbox';
    const resolvedPort = resolveIbkrPort({
      platform: selectedPlatform,
      useSandboxMode: selectedUseSandbox,
    });

    if (configIbkrSocketPort) {
      configIbkrSocketPort.textContent = `${resolvedPort}`;
    }

    if (configIbkrApiSettingsPath) {
      configIbkrApiSettingsPath.textContent = selectedPlatform === 'gateway'
        ? 'Account → API → Settings'
        : 'Global Configuration → API → Settings';
    }

    if (configIbkrActiveXItem) {
      configIbkrActiveXItem.classList.toggle('hidden', selectedPlatform !== 'tws');
    }

    if (configIbkrTwsPrereq) {
      configIbkrTwsPrereq.classList.remove('hidden');
    }
  }

  function updateEnvironmentOptionsForAdapter(selectedAdapterId) {
    if (!configEnvSelect) return;

    const sandboxOption = configEnvSelect.querySelector('option[value="sandbox"]');
    const liveOption = configEnvSelect.querySelector('option[value="live"]');
    if (!sandboxOption || !liveOption) return;

    if (selectedAdapterId === 'ibkr') {
      sandboxOption.textContent = 'Paper';
      liveOption.textContent = 'Live';
      return;
    }

    sandboxOption.textContent = 'Sandbox (Paper Trading)';
    liveOption.textContent = 'Live';
  }

  function updateBrokerSpecificFields() {
    if (!configAdapterSelect || !configEnvSelect) return;

    const storedSettings = getCurrentSettings();
    const selectedAdapterId = configAdapterSelect.value;
    const selectedUseSandbox = configEnvSelect.value === 'sandbox';
    const selectedEnvKey = resolveEnvironmentConfigKey(selectedAdapterId, selectedUseSandbox);
    const adapterConfig = getAllAdapterConfigs()?.[selectedAdapterId] ?? {};
    const selectedEnvConfig = adapterConfig?.[selectedEnvKey] ?? {};
    const credentialOverrides = storedSettings?.credentials?.[selectedAdapterId]?.[selectedEnvKey] ?? {};
    const ibkrSettings = storedSettings?.ibkr?.[selectedEnvKey] ?? {};
    const currentIbkrPlatform = `${configIbkrPlatformSelect?.value ?? ''}`.trim().toLowerCase();
    const currentIbkrHost = `${configIbkrIpInput?.value ?? ''}`.trim();

    updateEnvironmentOptionsForAdapter(selectedAdapterId);
    updateConnectButtonLabel(selectedAdapterId);

    const showTastyTradeCredentialFields = selectedAdapterId === 'tastytrade'
      && !!configTastyTradeFields
      && !!configClientIdInput
      && !!configClientSecretInput;

    const showIbkrFields = selectedAdapterId === 'ibkr'
      && !!configIbkrFields
      && !!configIbkrPlatformSelect
      && !!configIbkrIpInput;

    if (showTastyTradeCredentialFields) {
      configTastyTradeFields.classList.remove('hidden');
      configClientIdInput.value = `${credentialOverrides?.clientId ?? selectedEnvConfig?.clientId ?? ''}`;
      configClientSecretInput.value = `${credentialOverrides?.clientSecret ?? selectedEnvConfig?.clientSecret ?? ''}`;
    } else {
      configTastyTradeFields?.classList.add('hidden');
    }

    if (showIbkrFields) {
      configIbkrFields.classList.remove('hidden');
      const nextPlatform = `${ibkrSettings?.platform ?? ''}`.trim().toLowerCase();
      const nextHost = `${ibkrSettings?.host ?? ''}`.trim();
      configIbkrPlatformSelect.value = currentIbkrPlatform || nextPlatform || 'tws';
      configIbkrIpInput.value = currentIbkrHost || nextHost || '127.0.0.1';
      updateIbkrPortNote();
    } else {
      configIbkrFields?.classList.add('hidden');
    }
  }

  function saveConfigFromControls() {
    if (!configAdapterSelect || !configEnvSelect) {
      return { ok: false, requiresReload: false };
    }

    const storedSettings = getCurrentSettings();
    const nextAdapterId = configAdapterSelect.value;
    const nextUseSandbox = configEnvSelect.value === 'sandbox';
    const nextEnvKey = resolveEnvironmentConfigKey(nextAdapterId, nextUseSandbox);
    const currentCredentialSettings = storedSettings?.credentials ?? {};
    const nextCredentialSettings = {
      ...currentCredentialSettings,
    };
    const nextIbkrSettings = {
      ...(storedSettings?.ibkr ?? {}),
    };

    const isAdapterAvailable = typeof getAdapterFactory?.(nextAdapterId) === 'function';

    if (nextAdapterId === 'tastytrade') {
      const nextClientId = `${configClientIdInput?.value ?? ''}`.trim();
      const nextClientSecret = `${configClientSecretInput?.value ?? ''}`.trim();

      if (!nextClientId || !nextClientSecret) {
        showToast?.('TastyTrade requires Client ID and Client Secret.', 'error');
        return { ok: false, requiresReload: false };
      }

      nextCredentialSettings.tastytrade = {
        ...(nextCredentialSettings.tastytrade ?? {}),
        [nextEnvKey]: {
          clientId: nextClientId,
          clientSecret: nextClientSecret,
        },
      };
    } else if (nextAdapterId === 'ibkr') {
      const nextPlatform = `${configIbkrPlatformSelect?.value ?? ''}`.trim().toLowerCase();
      const nextHost = `${configIbkrIpInput?.value ?? ''}`.trim();

      if (!nextPlatform || !['tws', 'gateway'].includes(nextPlatform)) {
        showToast?.('IBKR requires selecting TWS or IB Gateway.', 'error');
        return { ok: false, requiresReload: false };
      }

      if (!nextHost) {
        showToast?.('IBKR requires an IP address.', 'error');
        return { ok: false, requiresReload: false };
      }

      nextIbkrSettings[nextEnvKey] = {
        platform: nextPlatform,
        host: nextHost,
      };
    }

    const nextSettings = {
      ...storedSettings,
      selectedBroker: nextAdapterId,
      useSandbox: nextUseSandbox,
      credentials: nextCredentialSettings,
      ibkr: nextIbkrSettings,
    };

    if (isAdapterAvailable) {
      nextSettings.activeAdapter = nextAdapterId;
    }

    persistSettings?.(nextSettings);

    if (!isAdapterAvailable) {
      showToast?.(`Saved ${nextAdapterId.toUpperCase()} settings. Adapter activation will be available once runtime support is added.`, 'info');
      return { ok: false, requiresReload: false };
    }

    const requiresReload = nextAdapterId !== activeAdapterId || nextUseSandbox !== appUseSandbox;
    return { ok: true, requiresReload };
  }

  function initialize() {
    if (!configAdapterSelect || !configEnvSelect || !btnConnect) return;

    const storedSettings = getCurrentSettings();
    const preferredAdapterId = `${storedSettings?.selectedBroker ?? activeAdapterId}`.toLowerCase();
    const selectedAdapterExists = Array.from(configAdapterSelect.options)
      .some(option => option.value === preferredAdapterId);

    if (selectedAdapterExists) {
      configAdapterSelect.value = preferredAdapterId;
    } else {
      configAdapterSelect.value = activeAdapterId;
    }

    configEnvSelect.value = appUseSandbox ? 'sandbox' : 'live';
    lastKnownEnvValue = configEnvSelect.value;
    updateBrokerSpecificFields();

    configAdapterSelect.addEventListener('change', updateBrokerSpecificFields);
    configEnvSelect.addEventListener('change', () => {
      if (envMutationLock) {
        configEnvSelect.value = lastKnownEnvValue;
        return;
      }

      lastKnownEnvValue = configEnvSelect.value;
      updateBrokerSpecificFields();
    });
    configIbkrPlatformSelect?.addEventListener('change', () => {
      const currentEnv = lastKnownEnvValue || configEnvSelect.value;
      envMutationLock = true;

      updateIbkrPortNote();

      if (configEnvSelect.value !== currentEnv) {
        configEnvSelect.value = currentEnv;
      }

      setTimeout(() => {
        if (configEnvSelect.value !== currentEnv) {
          configEnvSelect.value = currentEnv;
        }

        lastKnownEnvValue = currentEnv;
        envMutationLock = false;
      }, 0);
    });

    btnConnect.addEventListener('click', event => {
      const result = saveConfigFromControls();
      if (!result?.ok) {
        try {
          sessionStorage.removeItem(AUTO_CONNECT_AFTER_RELOAD_KEY);
        } catch {
          // no-op
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }

      if (result.requiresReload) {
        try {
          sessionStorage.setItem(AUTO_CONNECT_AFTER_RELOAD_KEY, '1');
        } catch {
          // no-op
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        setTimeout(() => {
          window.location.reload();
        }, 250);
        return;
      }

      try {
        sessionStorage.removeItem(AUTO_CONNECT_AFTER_RELOAD_KEY);
      } catch {
        // no-op
      }
    });
  }

  return {
    initialize,
    saveConfigFromControls,
  };
}

window.createSettingsController = createSettingsController;
