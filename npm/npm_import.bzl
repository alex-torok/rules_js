"""Repository rules to fetch third-party npm packages

Load these with,

```starlark
load("@aspect_rules_js//npm:npm_import.bzl", "npm_translate_lock", "npm_import")
```

These use Bazel's downloader to fetch the packages.
You can use this to redirect all fetches through a store like Artifactory.

See <https://blog.aspect.dev/configuring-bazels-downloader> for more info about how it works
and how to configure it.

[`npm_translate_lock`](#npm_translate_lock) is the primary user-facing API.
It uses the lockfile format from [pnpm](https://pnpm.io/motivation) because it gives us reliable
semantics for how to dynamically lay out `node_modules` trees on disk in bazel-out.

To create `pnpm-lock.yaml`, consider using [`pnpm import`](https://pnpm.io/cli/import)
to preserve the versions pinned by your existing `package-lock.json` or `yarn.lock` file.

If you don't have an existing lock file, you can run `npx pnpm install --lockfile-only`.

Advanced users may want to directly fetch a package from npm rather than start from a lockfile.
[`npm_import`](#npm_import) does this.
"""

load("//npm/private:npm_import.bzl", _npm_import_lib = "npm_import", _npm_import_links_lib = "npm_import_links")
load("//npm/private:utils.bzl", _utils = "utils")
load("//npm/private:npm_translate_lock.bzl", _npm_translate_lock_lib = "npm_translate_lock")

npm_translate_lock = repository_rule(
    doc = _npm_translate_lock_lib.doc,
    implementation = _npm_translate_lock_lib.implementation,
    attrs = _npm_translate_lock_lib.attrs,
)

_npm_import_links = repository_rule(
    implementation = _npm_import_links_lib.implementation,
    attrs = _npm_import_links_lib.attrs,
)

_npm_import = repository_rule(
    implementation = _npm_import_lib.implementation,
    attrs = _npm_import_lib.attrs,
)

def npm_import(
        name,
        package,
        version,
        deps = {},
        transitive_closure = {},
        root_package = "",
        link_workspace = "",
        link_packages = {},
        run_lifecycle_hooks = False,
        integrity = "",
        url = "",
        patch_args = ["-p0"],
        patches = [],
        custom_postinstall = ""):
    """Import a single npm package into Bazel.

    Normally you'd want to use `npm_translate_lock` to import all your packages at once.
    It generates `npm_import` rules.
    You can create these manually if you want to have exact control.

    Bazel will only fetch the given package from an external registry if the package is
    required for the user-requested targets to be build/tested.

    This is a repository rule, which should be called from your `WORKSPACE` file
    or some `.bzl` file loaded from it. For example, with this code in `WORKSPACE`:

    ```starlark
    npm_import(
        name = "npm__at_types_node_15.12.2",
        package = "@types/node",
        version = "15.12.2",
        integrity = "sha512-zjQ69G564OCIWIOHSXyQEEDpdpGl+G348RAKY0XXy9Z5kU9Vzv1GMNnkar/ZJ8dzXB3COzD9Mo9NtRZ4xfgUww==",
    )
    ```

    > This is similar to Bazel rules in other ecosystems named "_import" like
    > `apple_bundle_import`, `scala_import`, `java_import`, and `py_import`.
    > `go_repository` is also a model for this rule.

    The name of this repository should contain the version number, so that multiple versions of the same
    package don't collide.
    (Note that the npm ecosystem always supports multiple versions of a library depending on where
    it is required, unlike other languages like Go or Python.)

    To consume the downloaded package in rules, it must be "linked" into the link package in the
    package's `BUILD.bazel` file:

    ```
    load("@npm__at_types_node__15.12.2__links//:defs.bzl", npm_link_types_node = "npm_link_imported_package")

    npm_link_types_node(name = "node_modules")
    ```

    This links `@types/node` into the `node_modules` of this package with the target name `:node_modules/@types/node`.

    A `:node_modules/@types/node/dir` filegroup target is also created that provides the the directory artifact of the npm package.
    This target can be used to create entry points for binary target or to access files within the npm package.

    NB: You can choose any target name for the link target but we recommend using the `node_modules/@scope/name` and
    `node_modules/name` convention for readability.

    When using `npm_translate_lock`, you can link all the npm dependencies in the lock file for a package:

    ```
    load("@npm//:defs.bzl", "npm_link_all_packages")

    npm_link_all_packages(name = "node_modules")
    ```

    This creates `:node_modules/name` and `:node_modules/@scope/name` targets for all direct npm dependencies in the package.
    It also creates `:node_modules/name/dir` and `:node_modules/@scope/name/dir` filegroup targets that provide the the directory artifacts of their npm packages.
    These target can be used to create entry points for binary target or to access files within the npm package.

    If you have a mix of `npm_link_all_packages` and `npm_link_imported_package` functions to call you can pass the
    `npm_link_imported_package` link functions to the `imported_links` attribute of `npm_link_all_packages` to link
    them all in one call. For example,

    ```
    load("@npm//:defs.bzl", "npm_link_all_packages")
    load("@npm__at_types_node__15.12.2__links//:defs.bzl", npm_link_types_node = "npm_link_imported_package")

    npm_link_all_packages(
        name = "node_modules",
        imported_links = [
            npm_link_types_node,
        ]
    )
    ```

    This has the added benefit of adding the `imported_links` to the convienence `:node_modules` target which
    includes all direct dependencies in that package.

    NB: You can pass an name to npm_link_all_packages and this will change the targets generated to "{name}/@scope/name" and
    "{name}/name". We recommend using "node_modules" as the convention for readability.

    To change the proxy URL we use to fetch, configure the Bazel downloader:

    1. Make a file containing a rewrite rule like

        rewrite (registry.nodejs.org)/(.*) artifactory.build.internal.net/artifactory/$1/$2

    1. To understand the rewrites, see [UrlRewriterConfig] in Bazel sources.

    1. Point bazel to the config with a line in .bazelrc like
    common --experimental_downloader_config=.bazel_downloader_config

    [UrlRewriterConfig]: https://github.com/bazelbuild/bazel/blob/4.2.1/src/main/java/com/google/devtools/build/lib/bazel/repository/downloader/UrlRewriterConfig.java#L66

    Args:
        name: Name for this repository rule
        package: Name of the npm package, such as `acorn` or `@types/node`
        version: Version of the npm package, such as `8.4.0`
        deps: A dict other npm packages this one depends on where the key is the package name and value is the version
        transitive_closure: A dict all npm packages this one depends on directly or transitively where the key is the
            package name and value is a list of version(s) depended on in the closure.
        root_package: The root package where the node_modules virtual store is linked to.
            Typically this is the package that the pnpm-lock.yaml file is located when using `npm_translate_lock`.
        link_workspace: The workspace name where links will be created for this package.
            Typically this is the workspace that the pnpm-lock.yaml file is located when using `npm_translate_lock`.
            Can be left unspecified if the link workspace is the user workspace.
        link_packages: Dict of paths where direct links may be created at for this package to
            a list of link aliases to link as in each package. If aliases are an
            empty list this indicates to link as the package name.

            Defaults to {} which indicates that direct links may be created in any package as specified by
            the `direct` attribute of the generated npm_link_package.
        run_lifecycle_hooks: If true, runs `preinstall`, `install` and `postinstall` lifecycle hooks declared in this
            package.
        integrity: Expected checksum of the file downloaded, in Subresource Integrity format.
            This must match the checksum of the file downloaded.

            This is the same as appears in the pnpm-lock.yaml, yarn.lock or package-lock.json file.

            It is a security risk to omit the checksum as remote files can change.

            At best omitting this field will make your build non-hermetic.

            It is optional to make development easier but should be set before shipping.
        url: Optional url for this package. If unset, a default npm registry url is generated from
            the package name and version.
        patch_args: Arguments to pass to the patch tool.
            `-p1` will usually be needed for patches generated by git.
        patches: Patch files to apply onto the downloaded npm package.
        custom_postinstall: Custom string postinstall script to run on the installed npm package. Runs after any
            existing lifecycle hooks if `run_lifecycle_hooks` is True.
    """

    # By convention, the `{name}` repository contains the actual npm
    # package sources downloaded from the registry and extracted
    _npm_import(
        name = name,
        package = package,
        version = version,
        root_package = root_package,
        link_workspace = link_workspace,
        link_packages = link_packages,
        integrity = integrity,
        url = url,
        patch_args = patch_args,
        patches = patches,
        custom_postinstall = custom_postinstall,
        run_lifecycle_hooks = run_lifecycle_hooks,
    )

    # By convention, the `{name}{utils.links_repo_suffix}` repository contains the generated
    # code to link this npm package into one or more node_modules trees
    _npm_import_links(
        name = "{}{}".format(name, _utils.links_repo_suffix),
        package = package,
        version = version,
        root_package = root_package,
        link_packages = link_packages,
        deps = deps,
        transitive_closure = transitive_closure,
        lifecycle_build_target = run_lifecycle_hooks or not (not custom_postinstall),
    )
