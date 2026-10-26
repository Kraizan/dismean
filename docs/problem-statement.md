# Problem statement (verbatim)

## Distributed Mean

### Summary

Design a system that assigns a large job to be processed across a fleet of workers. The workers' outputs are aggregated into a single result which is returned to the user.

The number of workers (W) are at the system level and not specific to a job. You're free to keep them constant in the application or add support for making them configurable (Check Bonus section at the end)

The job itself will be to use the workers to compute the mean of every index across F files full of C random numbers

- F = number of files. (1 < F < 100k)
- C = number of random values in each file (1 < C < 1000k)

### Example

So if F=2 and C=3, and the input files are [1,2,3] and [4,5,6] then the output will be a single file consisting of the numbers [2.5, 3.5, 4.5].

Values for F, and C should all be chosen by the user. For the random numbers themselves, feel free to put whatever bound you want on them (between 0 and 1 for example). Files can use a format of your choice (csv, etc).

### Components

The components involved should be an API, DB, queue, and fleet of workers. The API should use NodeJs, Express, and Typescript. The workers should be in Python. The queue can be any kind, SQS, something local, anything.

### Flow

- There should be W workers who will sit idle while they wait for a job to appear on the queue.
- The user should be able to create a job by making an API call to create the job providing the values for C and F
- The API should then enqueue the job. Then once at least one worker is available the job will start being processed
- Remember the result of each worker must be combined to create the final averaged file. I'm interested to see how you approach this.

### Assumptions

- To simulate RAM constraints on each worker, let's say that a worker cannot process more than 5 files at a time. Therefore your system will need to figure out how to split up the job when F > 5.
- The generated files can be stored on the API's local file system or in a place of your choosing, like a bucket, as long as the workers have a way of pulling/reading them.
- Assume that workers process files at different speeds. Given this, design your worker orchestration algorithm such that workers spend as little time as possible idling or waiting on other slower workers.

### Critical aspects that we'd be looking for in the approach

- For a job where F > 5 (these are the jobs I'm most interested in) you can place one or multiple items on the queue. I.e. there is not a strict 1:1 relationship between job and item on queue.
- How efficient your algorithm of distributing the tasks is.
- How the system decides when a job is finished.
- Support submitting multiple jobs even if there are any ongoing jobs

### What is the expectation?

- While a complete working solution is desired but it's not the primary goal.
- We're mainly interested in how you design it keeping in mind how the system deals with the critical aspects defined above.
- So a well thought design doc covering the decisions taken and partial implementation is acceptable.

### Bonus

- Add support for keeping the number of workers (W) configurable via the API
- Create a UI
  - It should have some sort of updating logs about the state of the system such as number of workers free and busy, how many jobs completed, how many jobs on the queue, and any others you think are relevant here, use your best judgment.

### Local constraints (added by the project owner)

- Built and run locally only.
- Only free-to-use tools and libraries.
