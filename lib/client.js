window.__ModuleLoader__.load({
	id: "dsh-llm-motomoto",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let jsx = require("react/jsx-runtime");
		let react = require("react");

		//#region styles
		/*
		 * Written by hand rather than emitted from a CSS module: the `clientBundle`
		 * tsdown preset that produces those hashed class names is not published, so
		 * this bundle owns a prefixed class set and injects it once. Every colour is
		 * a shell design token, so the card follows the active theme.
		 */
		const CSS = [
			".dshMm_card{display:flex;flex-direction:column;gap:10px}",
			".dshMm_lead{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}",
			".dshMm_rows{display:flex;flex-direction:column;gap:10px}",
			".dshMm_row{display:flex;flex-direction:column;gap:2px}",
			".dshMm_label{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}",
			".dshMm_value{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;overflow-wrap:anywhere}",
			".dshMm_code{font-family:var(--ds-font-family-code);font-size:12px}",
			".dshMm_models{margin:0;padding-left:18px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}",
			".dshMm_models code{font-family:var(--ds-font-family-code);font-size:12px}",
			".dshMm_status{margin:0;min-height:18px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".dshMm_status[data-kind=error]{color:var(--dsw-alias-state-error-primary)}",
		].join("");
		const CSS_TAG_ID = "dsh-llm-motomoto/MotoMotoCard.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.setAttribute("data-plugin-css", CSS_TAG_ID);
			tag.textContent = CSS;
			document.head.append(tag);
		}
		//#endregion

		//#region locales
		/** Simplified Chinese dictionary and key source of truth. */
		const zh = {
			title: "MotoMoto 中转站",
			description: "MotoMoto 模型路由的状态。模型位于模型选择器的 MotoMoto 分组；路由配置（端点、凭据引用、模型）由用户设置层的 llm-pi-ai 段提供，本插件负责出站请求的 Codex 兼容。",
			group: "模型分组",
			endpoint: "端点",
			credential: "凭据引用",
			models: "模型",
			loading: "正在读取设置…",
			unavailable: "此浏览器无法读取该设置。",
			missing: "未找到 motomoto 路由。请在「设置 → 模型」的 llm-pi-ai 提供方中配置它。",
		};
		/** English dictionary checked against the Chinese key set. */
		const en = {
			title: "MotoMoto relay",
			description: "Status of the MotoMoto model route. The models sit in the MotoMoto group of the model picker; the route (endpoint, credential reference, models) lives in the user settings layer's llm-pi-ai section — this bundle contributes the outbound Codex compatibility a request needs.",
			group: "Model group",
			endpoint: "Endpoint",
			credential: "Credential reference",
			models: "Models",
			loading: "Reading settings…",
			unavailable: "This browser cannot read these settings.",
			missing: "No motomoto route found. Configure it under the llm-pi-ai providers in Settings - Models.",
		};
		//#endregion

		//#region status card
		/**
		 * Read the MotoMoto route out of the resolved llm-pi-ai section.
		 * @param {unknown} value - the scope snapshot's resolved value.
		 * @returns {object | undefined} the provider route, when one is configured.
		 */
		function routeOf(value) {
			const providers = typeof value === "object" && value !== null ? value.providers : undefined;
			const route = typeof providers === "object" && providers !== null ? providers.motomoto : undefined;
			return typeof route === "object" && route !== null ? route : undefined;
		}

		/**
		 * The well-formed model entries of a route, in declared order.
		 * @param {object | undefined} route - the provider route.
		 * @returns {object[]} entries with a string id.
		 */
		function modelsOf(route) {
			if (route === undefined) return [];
			const models = Array.isArray(route.models) ? route.models : [];
			return models.filter((model) => typeof model === "object" && model !== null && typeof model.id === "string");
		}

		/**
		 * One label/value row of the card.
		 * @param {string} label - the translated field label.
		 * @param {unknown} value - the field value to display.
		 * @param {boolean} code - render the value in the code font.
		 * @returns {JSX.Element} the row.
		 */
		function fieldRow(label, value, code) {
			return jsx.jsxs("div", {
				className: "dshMm_row",
				children: [
					jsx.jsx("span", { className: "dshMm_label", children: label }),
					jsx.jsx("span", {
						className: code ? "dshMm_value dshMm_code" : "dshMm_value",
						children: value === undefined || value === null ? "" : value,
					}),
				],
			});
		}

		/**
		 * The MotoMoto status card: a read-only report of the live provider
		 * route, bound to the llm-pi-ai settings section the models page owns.
		 *
		 * The card deliberately writes nothing: the endpoint and model list are
		 * the models page's to edit, so this card only reports what a request
		 * would use — group title, endpoint, credential reference, models.
		 *
		 * @param {object} props - the injected scope face plus the bound translator.
		 * @returns {JSX.Element} the card.
		 */
		function MotoMotoCard({ scope, t }) {
			const snapshot = react.useSyncExternalStore(
				react.useCallback((listener) => scope.subscribe(listener), [scope]),
				() => scope.getSnapshot(),
			);
			const route = snapshot.status === "ready" ? routeOf(snapshot.value) : undefined;
			const models = modelsOf(route);

			const status = () => {
				if (snapshot.status === "loading") return { kind: "info", text: t("loading") };
				if (snapshot.status === "unavailable") return { kind: "error", text: t("unavailable") };
				if (route === undefined) return { kind: "error", text: t("missing") };
				return { kind: "info", text: "" };
			};
			const shown = status();

			return jsx.jsxs("section", {
				className: "dshMm_card",
				"data-plugin-card": "llm-motomoto",
				"aria-busy": snapshot.status === "loading",
				children: [
					jsx.jsx("h3", { children: t("title") }),
					jsx.jsx("p", { className: "dshMm_lead", children: t("description") }),
					route === undefined
						? null
						: jsx.jsxs("div", {
								className: "dshMm_rows",
								children: [
									fieldRow(t("group"), route.displayName ?? "motomoto", false),
									fieldRow(t("endpoint"), route.baseURL, true),
									fieldRow(t("credential"), route.apiKeyEnv, true),
									jsx.jsxs("div", {
										className: "dshMm_row",
										children: [
											jsx.jsx("span", { className: "dshMm_label", children: t("models") }),
											jsx.jsx("ul", {
												className: "dshMm_models",
												children: models.map((model) =>
													jsx.jsxs("li", {
														children: [
															jsx.jsx("code", { children: model.id }),
															typeof model.name === "string" && model.name !== model.id ? " — " + model.name : "",
														],
													}, model.id),
												),
											}),
										],
									}),
								],
							}),
					jsx.jsx("p", {
						className: "dshMm_status",
						"data-kind": shown.kind,
						role: shown.kind === "error" ? "alert" : "status",
						children: shown.text,
					}),
				],
			});
		}
		//#endregion

		//#region plugin
		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.motomoto";
		/**
		 * The settings namespace the Host half registers, and the Host entry id
		 * its configuration form is served under.
		 */
		const SETTINGS_NS = "llm-motomoto";
		/**
		 * The provider route itself lives in the llm-pi-ai section of the user
		 * settings layer, so the card binds that namespace read-only to report
		 * the route a request would use.
		 */
		const ROUTE_NS = "llm-pi-ai";
		/**
		 * Package name the Plugins page files one bundle's page under. The keyed
		 * configuration seat is dispatched by package name, not by namespace.
		 */
		const BUNDLE_NAME = "dsh-llm-motomoto";
		/**
		 * Services this plugin needs from the browser runtime.
		 *
		 * The settings binder is deliberately absent. dsh 0.1.7 renamed it from
		 * `settingsScope` to `configForms` and no provider supplies the old name any
		 * more, and a fiber that declares a service nobody provides never activates
		 * — which fails the whole renderer boot, not just this card. Both binders
		 * are reached through a dynamic `ctx.inject` below, which simply stays
		 * pending on a generation that has no such service.
		 */
		const inject = ["slots", "locale"];

		/**
		 * Contribute the status card to the seat `binder` serves.
		 *
		 * Registration is deferred until the seat is declared, because the owning
		 * page declares it: `slots.inject` runs the callback on every declaration
		 * lifetime, so the card survives the plugin page unloading and coming back.
		 *
		 * @param {object} ctx - the injecting context.
		 * @param {object} scope - the bound settings form to report from.
		 * @param {object} options - the destination slot and its keyed or list identity.
		 * @returns {() => void} the wait's disposer.
		 */
		function contribute(ctx, scope, options) {
			const seat = options.name;
			return ctx.slots.inject(seat, () => {
				try {
					return ctx.slots.register(
						{
							...options,
							locale: NS,
							inject: () => ({ scope }),
						},
						MotoMotoCard,
					);
				} catch (error) {
					// The seat belongs to another package; losing the card must not
					// cost the user the rest of the plugin.
					console.warn(`[llm-motomoto] settings card registration into "${seat}" was refused`, error);
					return () => {};
				}
			});
		}

		/**
		 * Register the status card wherever this deployment serves it.
		 *
		 * dsh >= 0.1.7 shares one form between a direct Settings section and the
		 * bundle's Plugins detail page. Each slot is awaited independently, so
		 * either surface can be absent or reload without removing the other.
		 * Older hosts retain the settingsScope / settings.plugin.item path.
		 * A deployment without a settings binder still boots without a card.
		 *
		 * @param {object} ctx - the browser plugin context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "llm-motomoto: dictionaries");
			ctx.inject(["configForms"], (formsCtx) => {
				const forms = formsCtx.configForms;
				if (forms === undefined || typeof forms.get !== "function") return;
				const scope = forms.get(ROUTE_NS);
				contribute(formsCtx, scope, { name: "plugins.bundle.config", key: BUNDLE_NAME });
				contribute(formsCtx, scope, {
					name: "settings.section",
					id: SETTINGS_NS,
					order: 62,
					label: () => formsCtx.locale.bind(NS)("title"),
				});
			});
			ctx.inject(["settingsScope"], (binderCtx) => {
				const binder = binderCtx.settingsScope;
				if (binder === undefined || typeof binder.bind !== "function") return;
				contribute(binderCtx, binder.bind({ namespace: ROUTE_NS }), {
					name: "settings.plugin.item",
					key: SETTINGS_NS,
				});
			});
		}
		//#endregion

		exports.NS = NS;
		exports.SETTINGS_NS = SETTINGS_NS;
		exports.ROUTE_NS = ROUTE_NS;
		exports.BUNDLE_NAME = BUNDLE_NAME;
		exports.MotoMotoCard = MotoMotoCard;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
