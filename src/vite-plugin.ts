import { join as pathJoin, sep as pathSep, posix as posixPath } from "path";
import type { Plugin } from "vite";
import { assert } from "tsafe/assert";
import { getThisCodebaseRootDirPath } from "./tools/getThisCodebaseRootDirPath";
import * as fs from "fs";
import * as dotenv from "dotenv";
import * as cheerio from "cheerio";
import { exclude } from "tsafe/exclude";
import { nameOfTheGlobal, viteEnvsMetaFileBasename, updateTypingScriptEnvName } from "./constants";
import { injectScriptToDefineGlobal } from "./injectScriptToDefineGlobal";
import { renderHtmlAsEjs } from "./renderHtmlAsEjs";
import type { ViteEnvsMeta } from "./ViteEnvsMeta";
import { replaceAll } from "./tools/String.prototype.replaceAll";

export function viteEnvs() {
    let resultOfConfigResolved:
        | {
              appRootDirPath: string;
              baseBuildTimeEnv: Record<string, string>;
              env: Record<string, string>;
              envLocal: Record<string, string>;
              acceptedEnvVarNames: Set<string>;
              buildInfos:
                  | {
                        distDirPath: string;
                        assetsUrlPath: string;
                    }
                  | undefined;
          }
        | undefined = undefined;

    const plugin = {
        "name": "vite-envs",
        "configResolved": async resolvedConfig => {
            const appRootDirPath = resolvedConfig.root;
            const baseBuildTimeEnv = Object.fromEntries(
                Object.entries(resolvedConfig.env).map(([key, value]) => [key, `${value}`])
            );

            const [env, envLocal] = [".env", ".env.local"].map(
                (fileBasename): Record<string, string> => {
                    const filePath = pathJoin(appRootDirPath, fileBasename);

                    if (!fs.existsSync(filePath)) {
                        return {};
                    }

                    const { parsed } = dotenv.config({
                        "path": filePath,
                        "encoding": "utf8"
                    });

                    assert(parsed !== undefined);

                    return parsed;
                }
            );

            const acceptedEnvVarNames = new Set([...Object.keys(baseBuildTimeEnv), ...Object.keys(env)]);

            resultOfConfigResolved = {
                appRootDirPath,
                baseBuildTimeEnv,
                env,
                envLocal,
                acceptedEnvVarNames,
                "buildInfos": undefined
            };

            fs.writeFileSync(
                pathJoin(appRootDirPath, "src", "vite-env.d.ts"),
                Buffer.from(
                    [
                        `/// <reference types="vite/client" />`,
                        ``,
                        `interface ImportMetaEnv {`,
                        `    readonly VITE_FOO: string;`,
                        `}`,
                        ``,
                        `interface ImportMeta {`,
                        `readonly env: ImportMetaEnv;`,
                        `}`
                    ].join("\n"),
                    "utf8"
                )
            );

            if (updateTypingScriptEnvName in process.env) {
                process.exit(0);
            }

            if (resolvedConfig.command !== "build") {
                return;
            }

            resultOfConfigResolved.buildInfos = {
                "distDirPath": pathJoin(appRootDirPath, resolvedConfig.build.outDir),
                "assetsUrlPath": posixPath.join(
                    resolvedConfig.env.BASE_URL,
                    resolvedConfig.build.assetsDir
                )
            };
        },
        "transform": (code, id) => {
            assert(resultOfConfigResolved !== undefined);

            const { appRootDirPath } = resultOfConfigResolved;

            let transformedCode: string | undefined = undefined;

            replace_import_meta_env_base_url_in_source_code: {
                {
                    const isWithinSourceDirectory = id.startsWith(
                        pathJoin(appRootDirPath, "src") + pathSep
                    );

                    if (!isWithinSourceDirectory) {
                        break replace_import_meta_env_base_url_in_source_code;
                    }
                }

                {
                    const isJavascriptFile = id.endsWith(".js") || id.endsWith(".jsx");
                    const isTypeScriptFile = id.endsWith(".ts") || id.endsWith(".tsx");

                    if (!isTypeScriptFile && !isJavascriptFile) {
                        break replace_import_meta_env_base_url_in_source_code;
                    }
                }

                if (transformedCode === undefined) {
                    transformedCode = code;
                }

                transformedCode = replaceAll(
                    transformedCode,
                    "import.meta.env",
                    `window.${nameOfTheGlobal}`
                );
            }

            if (transformedCode === undefined) {
                return;
            }

            return {
                "code": transformedCode
            };
        },
        "transformIndexHtml": {
            "order": "pre",
            "handler": html => {
                assert(resultOfConfigResolved !== undefined);

                const { baseBuildTimeEnv, env, envLocal, buildInfos, acceptedEnvVarNames } =
                    resultOfConfigResolved;

                create_vite_envs_meta_file: {
                    if (buildInfos === undefined) {
                        break create_vite_envs_meta_file;
                    }

                    const { assetsUrlPath, distDirPath } = buildInfos;

                    const viteEnvsMeta: ViteEnvsMeta = {
                        "version": JSON.parse(
                            fs
                                .readFileSync(pathJoin(getThisCodebaseRootDirPath(), "package.json"))
                                .toString("utf8")
                        ).version,
                        assetsUrlPath,
                        "htmlPre": html,
                        env,
                        baseBuildTimeEnv
                    };

                    if (!fs.existsSync(distDirPath)) {
                        fs.mkdirSync(distDirPath, { "recursive": true });
                    }

                    fs.writeFileSync(
                        pathJoin(distDirPath, viteEnvsMetaFileBasename),
                        JSON.stringify(viteEnvsMeta, undefined, 4)
                    );
                }

                const mergedEnv = {
                    ...baseBuildTimeEnv,
                    ...env,
                    ...envLocal,
                    ...Object.fromEntries(
                        Object.entries(process.env)
                            .filter(([key]) => acceptedEnvVarNames.has(key))
                            .map(([key, value]) =>
                                value === undefined ? undefined : ([key, value] as const)
                            )
                            .filter(exclude(undefined))
                    )
                };

                const renderedHtml = renderHtmlAsEjs({
                    html,
                    "env": mergedEnv
                });

                const $ = cheerio.load(renderedHtml);

                injectScriptToDefineGlobal({
                    $,
                    "env": mergedEnv
                });

                return $.html();
            }
        }
    } satisfies Plugin;

    return plugin as any;
}
