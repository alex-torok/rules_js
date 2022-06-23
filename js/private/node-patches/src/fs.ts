/**
 * @license
 * Copyright 2019 The Bazel Authors. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Stats } from 'fs'
import * as path from 'path'
import * as util from 'util'

// windows cant find the right types
type Dir = any
type Dirent = any

// using require here on purpose so we can override methods with any
// also even though imports are mutable in typescript the cognitive dissonance is too high because
// es modules
const _fs = require('fs')

export const patcher = (fs: any = _fs, roots: string[]) => {
    fs = fs || _fs
    roots = roots || []
    roots = roots.filter((root) => fs.existsSync(root))
    if (!roots.length) {
        if (process.env.VERBOSE_LOGS) {
            console.error(
                'fs patcher called without any valid root paths ' + __filename
            )
        }
        return
    }

    const origLstat = fs.lstat.bind(fs)
    const origLstatSync = fs.lstatSync.bind(fs)

    const origReaddir = fs.readdir.bind(fs)
    const origReaddirSync = fs.readdirSync.bind(fs)

    const origReadlink = fs.readlink.bind(fs)
    const origReadlinkSync = fs.readlinkSync.bind(fs)

    const origRealpath = fs.realpath.bind(fs)
    const origRealpathNative = fs.realpath.native
    const origRealpathSync = fs.realpathSync.bind(fs)
    const origRealpathSyncNative = fs.realpathSync.native

    const isEscape = escapeFunction(roots)

    // =========================================================================
    // fs.lstat
    // =========================================================================

    fs.lstat = (...args: any[]) => {
        let cb = args.length > 1 ? args[args.length - 1] : undefined

        // preserve error when calling function without required callback
        if (!cb) {
            return origLstat(...args)
        }

        cb = once(cb)

        // override the callback
        args[args.length - 1] = (err: Error, stats: Stats) => {
            if (err) return cb(err)

            if (!stats.isSymbolicLink()) {
                // the file is not a symbolic link so there is nothing more to do
                return cb(null, stats)
            }

            args[0] = path.resolve(args[0])
            const guardedReadLink: string = guardedReadLinkSync(args[0])
            if (guardedReadLink != args[0]) {
                // there are one or more hops within the guards so there is nothing more to do
                return cb(null, stats)
            }

            // there are no hops so lets report the stats of the real file
            origRealpath(args[0], (err, str) => {
                if (err) {
                    if (err.code === 'ENOENT') {
                        // broken link so there is nothing more to do
                        return cb(null, stats)
                    }
                    return cb(err)
                }
                return origLstat(str, (err, str) => cb(err, str))
            })
        }

        origLstat(...args)
    }

    fs.lstatSync = (...args: any[]) => {
        const stats = origLstatSync(...args)

        if (!stats.isSymbolicLink()) {
            // the file is not a symbolic link so there is nothing more to do
            return stats
        }

        args[0] = path.resolve(args[0])
        const guardedReadLink: string = guardedReadLinkSync(args[0])
        if (guardedReadLink != args[0]) {
            // there are one or more hops within the guards so there is nothing more to do
            return stats
        }

        try {
            // there are no hops so lets report the stats of the real file
            return origLstatSync(origRealpathSync(args[0]), args.slice(1))
        } catch (e) {
            if (e.code === 'ENOENT') {
                // broken link so there is nothing more to do
                return stats
            }
            throw e
        }
    }

    // =========================================================================
    // fs.realpath
    // =========================================================================

    fs.realpath = (...args: any[]) => {
        let cb = args.length > 1 ? args[args.length - 1] : undefined

        // preserve error when calling function without required callback
        if (!cb) {
            return origRealpath(...args)
        }

        cb = once(cb)

        args[args.length - 1] = (err: Error, str: string) => {
            if (err) return cb(err)
            const escapedRoot: string | false = isEscape(args[0], str)
            if (escapedRoot) {
                return cb(null, guardedRealPathSync(args[0], escapedRoot))
            } else {
                return cb(null, str)
            }
        }

        origRealpath(...args)
    }

    fs.realpath.native = (...args: any[]) => {
        let cb = args.length > 1 ? args[args.length - 1] : undefined

        // preserve error when calling function without required callback
        if (!cb) {
            return origRealpathNative(...args)
        }

        cb = once(cb)

        args[args.length - 1] = (err: Error, str: string) => {
            if (err) return cb(err)
            const escapedRoot: string | false = isEscape(args[0], str)
            if (escapedRoot) {
                return cb(null, guardedRealPathSync(args[0], escapedRoot))
            } else {
                return cb(null, str)
            }
        }

        origRealpathNative(...args)
    }

    fs.realpathSync = (...args: any[]) => {
        const str = origRealpathSync(...args)
        const escapedRoot: string | false = isEscape(args[0], str)
        if (escapedRoot) {
            return guardedRealPathSync(args[0], escapedRoot)
        }
        return str
    }

    fs.realpathSync.native = (...args: any[]) => {
        const str = origRealpathSyncNative(...args)
        const escapedRoot: string | false = isEscape(args[0], str)
        if (escapedRoot) {
            return guardedRealPathSync(args[0], escapedRoot)
        }
        return str
    }

    // =========================================================================
    // fs.readlink
    // =========================================================================

    fs.readlink = (...args: any[]) => {
        let cb = args.length > 1 ? args[args.length - 1] : undefined

        // preserve error when calling function without required callback
        if (!cb) {
            return origReadlink(...args)
        }

        cb = once(cb)
        args[args.length - 1] = (err: Error, str: string) => {
            if (err) return cb(err)
            const resolved = path.resolve(args[0])
            str = path.resolve(path.dirname(resolved), str)
            const escapedRoot: string | false = isEscape(resolved, str)
            if (escapedRoot) {
                let next: string | false = nextHop(str)
                if (!next) {
                    if (next == undefined) {
                        // The escape from the root is not mappable back into the root; throw EINVAL
                        let err = new Error(
                            `ENOENT: no such file or directory, realpath '${args[0]}'`
                        )
                        ;(err as any).errno = -2
                        ;(err as any).syscall = 'readlink'
                        ;(err as any).code = 'ENOENT'
                        ;(err as any).path = args[0]
                        return cb(err)
                    } else {
                        // The escape from the root is not mappable back into the root; throw EINVAL
                        let err = new Error(
                            `EINVAL: invalid argument, readlink '${args[0]}'`
                        )
                        ;(err as any).errno = -22
                        ;(err as any).syscall = 'readlink'
                        ;(err as any).code = 'EINVAL'
                        ;(err as any).path = args[0]
                        return cb(err)
                    }
                }
                next = path.resolve(
                    path.dirname(resolved),
                    path.relative(path.dirname(str), next)
                )
                if (
                    next != resolved &&
                    !isEscape(resolved, next, [escapedRoot])
                ) {
                    return cb(null, next)
                }
                // The escape from the root is not mappable back into the root; we must make
                // this look like a real file so we call readlink on the realpath which we
                // expect to return an error
                return origRealpath(resolved, (err, str) => {
                    if (err) return cb(err)
                    return origReadlink(str, (err, str) => cb(err, str))
                })
            } else {
                return cb(null, str)
            }
        }

        origReadlink(...args)
    }

    fs.readlinkSync = (...args: any[]) => {
        const resolved = path.resolve(args[0])

        const str = path.resolve(
            path.dirname(resolved),
            origReadlinkSync(...args)
        )

        const escapedRoot: string | false = isEscape(resolved, str)
        if (escapedRoot) {
            let next: string | false = nextHop(str)
            if (!next) {
                if (next == undefined) {
                    // The escape from the root is not mappable back into the root; throw EINVAL
                    let err = new Error(
                        `ENOENT: no such file or directory, realpath '${args[0]}'`
                    )
                    ;(err as any).errno = -2
                    ;(err as any).syscall = 'readlink'
                    ;(err as any).code = 'ENOENT'
                    ;(err as any).path = args[0]
                    throw err
                } else {
                    // The escape from the root is not mappable back into the root; throw EINVAL
                    let err = new Error(
                        `EINVAL: invalid argument, readlink '${args[0]}'`
                    )
                    ;(err as any).errno = -22
                    ;(err as any).syscall = 'readlink'
                    ;(err as any).code = 'EINVAL'
                    ;(err as any).path = args[0]
                    throw err
                }
            }
            next = path.resolve(
                path.dirname(resolved),
                path.relative(path.dirname(str), next)
            )
            if (next != resolved && !isEscape(resolved, next, [escapedRoot])) {
                return next
            }
            // The escape from the root is not mappable back into the root; throw EINVAL
            let err = new Error(
                `EINVAL: invalid argument, readlink '${args[0]}'`
            )
            ;(err as any).errno = -22
            ;(err as any).syscall = 'readlink'
            ;(err as any).code = 'EINVAL'
            ;(err as any).path = args[0]
            throw err
        }
        return str
    }

    // =========================================================================
    // fs.readdir
    // =========================================================================

    fs.readdir = (...args: any[]) => {
        const p = path.resolve(args[0])

        let cb = args[args.length - 1]
        if (typeof cb !== 'function') {
            // this will likely throw callback required error.
            return origReaddir(...args)
        }

        cb = once(cb)

        args[args.length - 1] = (err: Error, result: Dirent[]) => {
            if (err) return cb(err)
            // user requested withFileTypes
            if (result[0] && result[0].isSymbolicLink) {
                Promise.all(result.map((v: Dirent) => handleDirent(p, v)))
                    .then(() => {
                        cb(null, result)
                    })
                    .catch((err) => {
                        cb(err)
                    })
            } else {
                // string array return for readdir.
                cb(null, result)
            }
        }

        origReaddir(...args)
    }

    fs.readdirSync = (...args: any[]) => {
        const res = origReaddirSync(...args)
        const p = path.resolve(args[0])
        res.forEach((v: Dirent | any) => {
            handleDirentSync(p, v)
        })
        return res
    }

    // =========================================================================
    // fs.opendir
    // =========================================================================

    if (fs.opendir) {
        const origOpendir = fs.opendir.bind(fs)
        fs.opendir = (...args: any[]) => {
            let cb = args[args.length - 1]
            // if this is not a function opendir should throw an error.
            // we call it so we don't have to throw a mock
            if (typeof cb === 'function') {
                cb = once(cb)
                args[args.length - 1] = async (err: Error, dir: Dir) => {
                    try {
                        cb(null, await handleDir(dir))
                    } catch (e) {
                        cb(e)
                    }
                }
                origOpendir(...args)
            } else {
                return origOpendir(...args).then((dir: Dir) => {
                    return handleDir(dir)
                })
            }
        }
    }

    // =========================================================================
    // fs.promises
    // =========================================================================

    /**
     * patch fs.promises here.
     *
     * this requires a light touch because if we trigger the getter on older nodejs versions
     * it will log an experimental warning to stderr
     *
     * `(node:62945) ExperimentalWarning: The fs.promises API is experimental`
     *
     * this api is available as experimental without a flag so users can access it at any time.
     */
    const promisePropertyDescriptor = Object.getOwnPropertyDescriptor(
        fs,
        'promises'
    )
    if (promisePropertyDescriptor) {
        const promises: any = {}
        promises.lstat = util.promisify(fs.lstat)
        // NOTE: node core uses the newer realpath function fs.promises.native instead of fs.realPath
        promises.realpath = util.promisify(fs.realpath.native)
        promises.readlink = util.promisify(fs.readlink)
        promises.readdir = util.promisify(fs.readdir)
        if (fs.opendir) promises.opendir = util.promisify(fs.opendir)
        // handle experimental api warnings.
        // only applies to version of node where promises is a getter property.
        if (promisePropertyDescriptor.get) {
            const oldGetter = promisePropertyDescriptor.get.bind(fs)
            const cachedPromises = {}

            promisePropertyDescriptor.get = () => {
                const _promises = oldGetter()
                Object.assign(cachedPromises, _promises, promises)
                return cachedPromises
            }
            Object.defineProperty(fs, 'promises', promisePropertyDescriptor)
        } else {
            // api can be patched directly
            Object.assign(fs.promises, promises)
        }
    }

    // =========================================================================
    // helper functions for dirs
    // =========================================================================

    async function handleDir(dir: Dir) {
        const p = path.resolve(dir.path)
        const origIterator = dir[Symbol.asyncIterator].bind(dir)
        const origRead: any = dir.read.bind(dir)

        dir[Symbol.asyncIterator] = async function* () {
            for await (const entry of origIterator()) {
                await handleDirent(p, entry)
                yield entry
            }
        }
        ;(dir.read as any) = async (...args: any[]) => {
            if (typeof args[args.length - 1] === 'function') {
                const cb = args[args.length - 1]
                args[args.length - 1] = async (err: Error, entry: Dirent) => {
                    cb(err, entry ? await handleDirent(p, entry) : null)
                }
                origRead(...args)
            } else {
                const entry = await origRead(...args)
                if (entry) {
                    await handleDirent(p, entry)
                }
                return entry
            }
        }
        const origReadSync: any = dir.readSync.bind(dir)
        ;(dir.readSync as any) = () => {
            return handleDirentSync(p, origReadSync())
        }

        return dir
    }

    function handleDirent(p: string, v: Dirent): Promise<Dirent> {
        return new Promise((resolve, reject) => {
            if (!v.isSymbolicLink()) {
                return resolve(v)
            }
            const f = path.resolve(p, v.name)
            if (f != guardedReadLinkSync(f)) {
                return resolve(v)
            }
            // There are no hops so we should hide the fact that the file is a symlink
            v.isSymbolicLink = () => false
            const stat = fs.statSync(origRealpathSync(f))
            patchDirent(v, stat)
            resolve(v)
        })
    }

    function handleDirentSync(p: string, v: Dirent | null) {
        if (v && v.isSymbolicLink) {
            if (v.isSymbolicLink()) {
                const f = path.resolve(p, v.name)
                if (f == guardedReadLinkSync(f)) {
                    // There are no hops so we should hide the fact that the file is a symlink
                    v.isSymbolicLink = () => false
                    const stat = fs.statSync(origRealpathSync(f))
                    patchDirent(v, stat)
                }
            }
        }
    }

    function nextHop(loc: string): string | false | undefined {
        let readlink
        let nested = []
        let maybe = loc
        for (;;) {
            try {
                readlink = origReadlinkSync(maybe)
            } catch (e) {
                if (e.code === 'ENOENT') {
                    // file does not exist
                    return undefined
                }
                nested.push(path.basename(maybe))
                const dirname = path.dirname(maybe)
                if (
                    !dirname ||
                    dirname == maybe ||
                    dirname == '.' ||
                    dirname == '/'
                ) {
                    // not a link
                    return false
                }
                maybe = dirname
                continue
            }
            if (!path.isAbsolute(readlink)) {
                readlink = path.resolve(maybe, readlink)
            }
            return path.join(readlink, ...nested.reverse())
        }
    }

    function guardedReadLinkSync(
        start: string,
        escapedRoot: string = undefined
    ) {
        let loc = start
        let next: string | false = nextHop(loc)
        if (!next) {
            // we're no longer hopping but we haven't escaped;
            // something funky happened in the filesystem
            return loc
        }
        if (
            escapedRoot
                ? isEscape(loc, next, [escapedRoot])
                : isEscape(loc, next)
        ) {
            // this hop takes us out of the guard
            const next2: string | false = nextHop(next)
            if (!next2) {
                // the chain is done
                return loc
            }
            const maybe = path.resolve(
                path.dirname(loc),
                path.relative(path.dirname(next), next2)
            )
            if (!isEscape(loc, maybe)) {
                // outside of the guard is a symlink but it is a relative link path
                // we can map within the guard so return that
                return maybe
            }
            // outside of the guard is a symlink that is not mappable inside the guard
            return loc
        }
        return next
    }

    function guardedRealPathSync(
        start: string,
        escapedRoot: string = undefined
    ) {
        if (!start) return start
        for (let loc = start, next: string | false; ; loc = next) {
            next = nextHop(loc)
            if (!next) {
                // we're no longer hopping but we haven't escaped;
                // something funky happened in the filesystem; throw ENOENT
                let err = new Error(
                    `ENOENT: no such file or directory, realpath '${start}'`
                )
                ;(err as any).errno = -2
                ;(err as any).syscall = 'realpath'
                ;(err as any).code = 'ENOENT'
                ;(err as any).path = start
                throw err
            }
            if (
                escapedRoot
                    ? isEscape(loc, next, [escapedRoot])
                    : isEscape(loc, next)
            ) {
                // this hop takes us out of the guard
                const next2: string | false = nextHop(next)
                if (!next2) {
                    // the chain is done
                    return loc
                }
                const maybe = path.resolve(
                    path.dirname(loc),
                    path.relative(path.dirname(next), next2)
                )
                if (!isEscape(loc, maybe)) {
                    // outside of the guard is a symlink but it is a relative link path
                    // we can map within the guard so return that
                    return maybe
                }
                // outside of the guard is a symlink that is not mappable inside the guard
                return loc
            }
        }
    }
}

// =========================================================================
// generic helper functions
// =========================================================================

export function isSubPath(parent, child) {
    return !path.relative(parent, child).startsWith('..')
}

export const escapeFunction = (_roots: string[]) => {
    // ensure roots are always absolute
    _roots = _roots.map((root) => path.resolve(root))
    function _isEscape(
        linkPath: string,
        linkTarget: string,
        roots = _roots
    ): false | string {
        // linkPath is the path of the symlink file itself
        // linkTarget is a path that the symlink points to one or more hops away

        if (!path.isAbsolute(linkPath)) {
            linkPath = path.resolve(linkPath)
        }

        if (!path.isAbsolute(linkTarget)) {
            linkTarget = path.resolve(linkTarget)
        }

        let escapedRoot = undefined
        for (const root of roots) {
            // If the link is in the root check if the realPath has escaped
            if (isSubPath(root, linkPath) || linkPath == root) {
                if (!isSubPath(root, linkTarget) && linkTarget != root) {
                    if (!escapedRoot || escapedRoot.length < root.length) {
                        // if escaping multiple roots then choose the longest one
                        escapedRoot = root
                    }
                }
            }
        }
        if (escapedRoot) {
            return escapedRoot
        }

        return false
    }

    return _isEscape
}

function once<T>(fn: (...args: unknown[]) => T) {
    let called = false

    return (...args: unknown[]) => {
        if (called) return
        called = true

        let err: Error | false = false
        try {
            fn(...args)
        } catch (_e) {
            err = _e
        }

        // blow the stack to make sure this doesn't fall into any unresolved promise contexts
        if (err) {
            setImmediate(() => {
                throw err
            })
        }
    }
}

function patchDirent(dirent: Dirent | any, stat: Stats | any) {
    // add all stat is methods to Dirent instances with their result.
    for (const i in stat) {
        if (i.indexOf('is') === 0 && typeof stat[i] === 'function') {
            //
            const result = stat[i]()
            if (result) dirent[i] = () => true
            else dirent[i] = () => false
        }
    }
}
