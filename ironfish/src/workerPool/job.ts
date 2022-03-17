/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Event } from '../event'
import { PromiseReject, PromiseResolve, PromiseUtils } from '../utils'
import { handleRequest } from './tasks/handlers'
import { JobAbortedError, SerializableJobAbortedError } from './tasks/jobAbort'
import { WorkerMessage } from './tasks/workerMessage'
import { Worker } from './worker'

export class Job {
  id: number
  request: WorkerMessage
  worker: Worker | null
  status: 'init' | 'queued' | 'executing' | 'success' | 'error' | 'aborted'
  promise: Promise<WorkerMessage>
  resolve: PromiseResolve<WorkerMessage>
  reject: PromiseReject

  onEnded = new Event<[Job]>()
  onChange = new Event<[Job, Job['status']]>()

  // This determines if JobAbortedError is fed into the response if the job is
  // aborted. The code base hasn't been upgraded to handle these so it should be
  // enabled for each job that now properly handles it until all jobs handle it.
  // Then this should be removed.
  enableJobAbortError = false

  constructor(request: WorkerMessage) {
    this.id = request.jobId
    this.request = request
    this.worker = null
    this.status = 'queued'

    const [promise, resolve, reject] = PromiseUtils.split<WorkerMessage>()
    this.promise = promise
    this.resolve = resolve
    this.reject = reject

    this.promise.catch(() => {
      // Eat the exception. You can still catch
      // the exception using job.response()
    })
  }

  abort(): void {
    if (this.status !== 'queued' && this.status !== 'executing') {
      return
    }

    const prevStatus = this.status
    this.status = 'aborted'
    this.onChange.emit(this, prevStatus)
    this.onEnded.emit(this)

    if (this.worker) {
      this.worker.send(new SerializableJobAbortedError(this.id))
      this.worker.jobs.delete(this.id)
    }

    if (this.reject && this.enableJobAbortError) {
      this.reject(new JobAbortedError())
    }
  }

  execute(worker: Worker | null = null): Job {
    const prevStatus = this.status
    this.status = 'executing'
    this.worker = worker
    this.onChange.emit(this, prevStatus)

    if (worker) {
      worker.send(this.request)
      return this
    }

    void handleRequest(this.request, this)
      .then((r) => {
        if (this.status !== 'aborted') {
          const prevStatus = this.status
          this.status = 'success'
          this.onChange.emit(this, prevStatus)
          this.onEnded.emit(this)
          this.resolve?.(r)
        }
      })
      .catch((e: unknown) => {
        if (this.status !== 'aborted') {
          const prevStatus = this.status
          this.status = 'error'
          this.onChange.emit(this, prevStatus)
          this.onEnded.emit(this)
          this.reject?.(e)
        }
      })

    return this
  }

  async result(): Promise<WorkerMessage> {
    return this.promise
  }
}
